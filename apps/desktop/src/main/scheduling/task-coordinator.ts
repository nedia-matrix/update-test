import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  accountSubmissionMode,
  resolveAccountPlatform,
  resolvePlatformSettings,
  preparePublishText,
  normalizePublishBody,
  platformSyncFailure,
  type PlatformSettings,
} from "@nedia-matrix/platform-sdk";
import {
  validatePublishDraftRequest,
  validateRemoteDraftRequest,
  validateRemoteAssetsForForm,
  type PreparePublishDraftRequest,
  type PrepareRemoteDraftRequest,
  type PublicationApplicationDependencies,
  type PublicationService,
  type PreparePublishDraftResult,
} from "@nedia-matrix/publishing";
import type { AccountService } from "@nedia-matrix/account-management";
import type { PlatformContentService } from "@nedia-matrix/platform-content";
import {
  TaskScheduler,
  TaskExecutionError,
  type TaskExecutionContext,
  type TaskOutcome,
} from "./task-scheduler.js";
import { TaskStore, type TaskRecord } from "./task-store.js";

type Files = PublicationApplicationDependencies["mediaSelections"] extends {
  create(input: infer I): string;
}
  ? I extends { files: infer F }
    ? F
    : never
  : never;
interface PublicationInput {
  request: Omit<PreparePublishDraftRequest, "mediaSelectionId">;
  settings: PlatformSettings;
  identity: { identityScheme: string | null; externalAccountId: string | null };
  files?: Files;
  remote?: PrepareRemoteDraftRequest;
}
interface CoordinatorDependencies {
  store: TaskStore;
  accounts: AccountService;
  content: PlatformContentService;
  publications: PublicationService;
  ports: Pick<
    PublicationApplicationDependencies,
    | "accounts"
    | "platforms"
    | "publishing"
    | "accountPublications"
    | "mediaSelections"
    | "remoteAssets"
  >;
  wasDeleted(requestId: string): boolean;
  resolveAsset(relativePath: string): Promise<string | undefined>;
  canStart(accountId: string): boolean;
  changed(): void;
  onError(error: unknown): void;
}
const completedStates = [
  "published",
  "failed",
  "cancelled",
  "rejected",
  "uncertain",
];

export class TaskCoordinator {
  readonly scheduler: TaskScheduler;
  private readonly owner = new AsyncLocalStorage<string>();
  private runtimeAllowed: (accountId: string) => boolean = () => false;
  private stopping = false;
  private schedulerFailed = false;
  private readonly readyListeners = new Set<() => void>();
  constructor(private readonly deps: CoordinatorDependencies) {
    this.scheduler = new TaskScheduler(deps.store, {
      account: (id) => deps.accounts.resolveAccount({ accountId: id }).account,
      canStart: (id) => deps.canStart(id),
      canPrunePublication: (task) => {
        if (deps.ports.accountPublications.isActive(task.accountId))
          return false;
        const record = deps.ports.publishing
          .list()
          .find((p) => p.requestId === task.requestId);
        if (record)
          return (
            completedStates.includes(record.publication.state) &&
            record.publication.state !== "uncertain"
          );
        return (
          (!task.businessStarted && task.state !== "uncertain") ||
          (!!task.requestId && deps.wasDeleted(task.requestId))
        );
      },
      execute: (task, context) =>
        this.owner.run(task.accountId, () => this.execute(task, context)),
      reconcile: (task, recovering) => this.reconcile(task, recovering),
      changed: () => {
        for (const listener of [...this.readyListeners]) listener();
        deps.changed();
      },
      onError: (error) => {
        this.schedulerFailed = true;
        for (const listener of [...this.readyListeners]) listener();
        deps.onError(error);
      },
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const listener of [...this.readyListeners]) listener();
    await this.scheduler.stop();
  }
  owns(accountId: string): boolean {
    return this.owner.getStore() === accountId;
  }
  setRuntimeAccess(allowed: (id: string) => boolean): void {
    this.runtimeAllowed = allowed;
  }
  private requireRequest(accountId: string, requestId: string) {
    if (
      this.deps.ports.publishing
        .list()
        .some(
          (p) =>
            p.requestId === requestId && p.publication.accountId !== accountId,
        )
    )
      throw new TypeError("request ID 已用于另一个账号");
    if (this.deps.wasDeleted(requestId))
      throw new TypeError("已删除的发布请求不得重放");
    const existing = this.deps.store.byRequest(requestId);
    if (existing && existing.accountId !== accountId)
      throw new TypeError("request ID 已用于另一个账号");
    if (existing?.historyCleared)
      throw new TypeError("发布请求历史已清理，不得重放");
    return existing;
  }
  enqueueLocal(request: PreparePublishDraftRequest): PreparePublishDraftResult {
    validatePublishDraftRequest(request);
    request = {
      ...request,
      accountId: this.deps.accounts.resolveAccount({
        accountId: request.accountId,
      }).account.id,
    };
    const requestId = request.requestId?.trim() ?? randomUUID();
    const existing = this.requireRequest(request.accountId, requestId);
    if (existing) return { status: "queued", taskId: existing.id, requestId };
    const prior = this.existingPublication(requestId);
    if (prior) return prior;
    const snapshot = this.snapshot(request);
    const selection = this.deps.ports.mediaSelections.acquire(
      request.mediaSelectionId,
      request.accountId,
      request.contentForm,
    );
    try {
      this.validateMediaCount(
        request.accountId,
        request.contentForm,
        selection.files.length,
      );
      if (selection.files.some((file) => !file.localRelativePath))
        throw new TypeError("排队发布必须使用已归档的持久素材");
      const task = this.scheduler.enqueuePublication({
        accountId: request.accountId,
        requestId,
        source: "manual",
        input: {
          ...snapshot,
          files: selection.files,
        } satisfies PublicationInput,
      });
      this.deps.ports.mediaSelections.consume(request.mediaSelectionId);
      return { status: "queued", taskId: task.id, requestId };
    } finally {
      this.deps.ports.mediaSelections.release(request.mediaSelectionId);
    }
  }
  async enqueueRemote(
    request: PrepareRemoteDraftRequest,
  ): Promise<PreparePublishDraftResult> {
    const requestId = validateRemoteDraftRequest(request);
    request = {
      ...request,
      accountId: this.deps.accounts.resolveAccount({
        accountId: request.accountId,
      }).account.id,
    };
    const existing = this.requireRequest(request.accountId, requestId);
    const prior = this.existingPublication(requestId);
    if (!existing && prior) return prior;
    let id = existing?.id;
    if (!id) {
      this.validateMediaCount(
        request.accountId,
        request.contentForm,
        request.assets.length,
      );
      const ordered = validateRemoteAssetsForForm(
        request.contentForm,
        request.assets,
      );
      const snapshot = this.snapshot({
        ...request,
        mediaSelectionId: "remote",
        requestId,
      });
      const task = this.scheduler.enqueuePublication({
        accountId: request.accountId,
        requestId,
        source: "runtime",
        input: {
          ...snapshot,
          remote: { ...request, assets: ordered },
        } satisfies PublicationInput,
      });
      id = task.id;
    }
    // Acceptance promises durable, reusable media, not expiring URLs. Download owns a task slot.
    await this.waitForInput(id);
    return { status: "queued", taskId: id, requestId };
  }
  private existingPublication(
    requestId: string,
  ): PreparePublishDraftResult | undefined {
    const record = this.deps.ports.publishing
      .list()
      .find((p) => p.requestId === requestId);
    return record
      ? {
          status: "already_started",
          publicationId: record.publication.id,
          state: record.publication.state,
        }
      : undefined;
  }
  private validateMediaCount(
    accountId: string,
    contentForm: "imageText" | "video",
    count: number,
  ): void {
    const account = this.deps.ports.accounts.require(accountId);
    const form = resolveAccountPlatform(this.deps.ports.platforms, account)
      .publishing?.forms[contentForm];
    if (
      !form ||
      count < 1 ||
      (form.constraints.mediaMaxCount !== undefined &&
        count > form.constraints.mediaMaxCount)
    )
      throw new TypeError("发布素材数量不符合平台约束");
  }
  protectedPaths(): Set<string> {
    return new Set(
      this.deps.store
        .list(true)
        .filter((t) => t.type === "publication")
        .flatMap((t) =>
          ((t.input as PublicationInput).files ?? []).flatMap((f) =>
            f.localRelativePath ? [f.localRelativePath] : [],
          ),
        ),
    );
  }
  protectsPublication(id: string): boolean {
    return this.deps.store
      .list(true)
      .some(
        (t) =>
          t.type === "publication" &&
          (t.publicationId === id ||
            (t.input as PublicationInput).request.sourcePublicationId === id),
      );
  }
  private async waitForInput(id: string): Promise<void> {
    while (true) {
      if (this.schedulerFailed)
        throw new Error(
          "调度状态保存失败，请通过 request ID 查询并在重启后恢复",
        );
      if (this.stopping) throw new Error("应用正在退出，任务将在下次启动恢复");
      const task = this.deps.store.get(id)!;
      if ((task.input as PublicationInput).files || task.state === "cancelled")
        return;
      if (["failed", "uncertain"].includes(task.state))
        throw new Error(task.error?.message ?? task.phase);
      await new Promise<void>((resolve) => {
        const done = () => {
          this.readyListeners.delete(done);
          resolve();
        };
        this.readyListeners.add(done);
      });
    }
  }
  private snapshot(request: PreparePublishDraftRequest): PublicationInput {
    const account = this.deps.accounts.resolveAccount({
      accountId: request.accountId,
    }).account;
    if (account.lifecycle !== "active") throw new TypeError("账号身份尚未识别");
    const platform = resolveAccountPlatform(this.deps.ports.platforms, account);
    const settings = resolvePlatformSettings(platform, account.settings);
    const mode = request.submissionMode ?? accountSubmissionMode({ settings });
    const form = platform.publishing?.forms[request.contentForm];
    if (!form || !form.submissionModes.includes(mode))
      throw new TypeError("账号不支持当前发布类型或提交方式");
    preparePublishText(
      form,
      normalizePublishBody(form, request.body.trim()),
      request.tags,
    );
    const { mediaSelectionId: _selection, ...draft } = request;
    return {
      request: { ...draft, submissionMode: mode },
      settings,
      identity: {
        identityScheme: account.identityScheme,
        externalAccountId: account.externalAccountId,
      },
    };
  }
  private async execute(
    task: TaskRecord,
    context: TaskExecutionContext,
  ): Promise<TaskOutcome> {
    if (
      task.source === "runtime" &&
      !task.hasDesktopRequest &&
      !task.ruleId &&
      !this.runtimeAllowed(task.accountId)
    )
      return {
        state: "cancelled",
        error: { code: "access_revoked", message: "账号外部访问权限已撤销" },
      };
    if (task.type === "publication")
      return this.executePublication(task, context);
    try {
      context.update({
        businessStarted: true,
        phase:
          task.type === "account_profile_sync"
            ? "同步账号资料"
            : "读取平台作品",
      });
      if (task.type === "account_profile_sync") {
        const result = await this.deps.accounts.refreshAccountProfile({
          accountId: task.accountId,
        });
        return { state: "completed", result };
      }
      const run = await this.deps.content.refresh(task.accountId, (progress) =>
        context.update({
          progress: { pages: progress.pagesRead, items: progress.itemsRead },
          retainedItems: Math.max(
            this.deps.store.get(task.id)?.retainedItems ?? 0,
            progress.itemsRead,
          ),
        }),
      );
      context.update({ result: run });
      if (run.failure) {
        const f = run.failure;
        throw new TaskExecutionError(
          f.code,
          f.message,
          f.retryable,
          f.retryAfterMs,
          f.resourcesClosed,
        );
      }
      return {
        state: run.status,
        result: run,
        ...(run.status === "failed"
          ? {
              error: {
                code: "read_failed",
                message: run.diagnostics.join("；"),
              },
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof TaskExecutionError) throw error;
      const f = platformSyncFailure(error);
      throw new TaskExecutionError(
        f.code,
        f.message,
        f.retryable,
        f.retryAfterMs,
        f.resourcesClosed,
      );
    }
  }
  private async executePublication(
    task: TaskRecord,
    context: TaskExecutionContext,
  ): Promise<TaskOutcome> {
    const input = task.input as PublicationInput;
    if (task.source === "runtime" && !this.runtimeAllowed(task.accountId))
      return {
        state: "cancelled",
        error: { code: "access_revoked", message: "账号外部访问权限已撤销" },
      };
    const account = this.deps.ports.accounts.require(task.accountId);
    if (
      account.identityScheme !== input.identity.identityScheme ||
      account.externalAccountId !== input.identity.externalAccountId
    )
      throw new TaskExecutionError(
        "identity_mismatch",
        "排队期间账号身份已变化",
      );
    if (!input.files && input.remote) {
      context.update({ phase: "固化发布素材" });
      const downloaded = await this.deps.ports.remoteAssets.download(
        task.requestId!,
        input.remote.assets,
      );
      input.files = downloaded.map(
        ({ created: _created, resourceReference: _reference, ...file }) => file,
      );
      delete input.remote;
      context.update({ input, phase: "发布素材已持久化" });
    }
    if (!input.files?.length) throw new TypeError("发布素材缺失");
    const paths: string[] = [];
    for (const file of input.files) {
      const path =
        file.localRelativePath &&
        (await this.deps.resolveAsset(file.localRelativePath));
      if (!path) throw new TypeError(`排队素材不可用：${file.name}`);
      paths.push(path);
    }
    if (task.source === "runtime" && !this.runtimeAllowed(task.accountId))
      return {
        state: "cancelled",
        error: { code: "access_revoked", message: "账号外部访问权限已撤销" },
      };
    const selection = this.deps.ports.mediaSelections.create({
      accountId: task.accountId,
      contentForm: input.request.contentForm,
      resourceReferences: paths,
      files: input.files,
    });
    // Conservative write-ahead marker. No replay after this boundary, even if Publication is not yet linked.
    context.update({ businessStarted: true, phase: "准备发布" });
    try {
      const result = await this.deps.publications.prepare(
        {
          ...input.request,
          requestId: task.requestId!,
          mediaSelectionId: selection,
        },
        input.settings,
      );
      const record = this.deps.ports.publishing
        .list()
        .find((p) => p.requestId === task.requestId);
      if (record) context.update({ publicationId: record.publication.id });
      const current = this.deps.store.get(task.id)!;
      const outcome = this.reconcile(current, false);
      if (outcome) return { ...outcome, result };
      if (record) {
        const active = this.deps.ports.accountPublications.isActive(
          task.accountId,
        );
        return {
          state: active
            ? record.publication.state === "awaiting_confirmation"
              ? "awaiting_confirmation"
              : "running"
            : "finalizing",
          result,
          ...(!active
            ? {
                error: {
                  code: "business_not_terminal",
                  message: "发布业务状态尚未完成持久化，保留账号占用",
                },
              }
            : {}),
        };
      }
      if (this.deps.ports.accountPublications.isActive(task.accountId))
        return {
          state: "finalizing",
          error: {
            code: "resource_close_failed",
            message: "发布资源尚未安全退出",
          },
        };
      return {
        state:
          result.status === "uncertain"
            ? "uncertain"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed",
        result,
        error: {
          code: result.status,
          message:
            "message" in result
              ? result.message
              : "reason" in result
                ? result.reason
                : "发布未能开始，请检查账号状态",
        },
      };
    } catch (error) {
      const record = this.deps.ports.publishing
        .list()
        .find((p) => p.requestId === task.requestId);
      if (record) context.update({ publicationId: record.publication.id });
      if (this.deps.ports.accountPublications.isActive(task.accountId))
        return {
          state: "finalizing",
          error: {
            code: "resource_close_failed",
            message: "发布资源尚未安全退出",
          },
        };
      return {
        state: "finalizing",
        error: {
          code: "publication_persistence_failed",
          message: error instanceof Error ? error.message : "发布失败",
        },
      };
    } finally {
      this.deps.ports.mediaSelections.consume(selection);
    }
  }
  private reconcile(
    task: TaskRecord,
    recovering: boolean,
  ): TaskOutcome | undefined {
    if (task.type !== "publication") return;
    const record = this.deps.ports.publishing
      .list()
      .find((p) => p.requestId === task.requestId);
    if (!record) return;
    if (task.publicationId !== record.publication.id) {
      task.publicationId = record.publication.id;
      this.deps.store.save(task);
    }
    if (
      !recovering &&
      this.deps.ports.accountPublications.isActive(task.accountId)
    ) {
      if (
        record.publication.state === "awaiting_confirmation" &&
        task.state !== "awaiting_confirmation"
      )
        return { state: "awaiting_confirmation" };
      if (
        completedStates.includes(record.publication.state) &&
        task.state !== "finalizing"
      )
        return { state: "finalizing" };
      if (
        record.publication.state !== "awaiting_confirmation" &&
        task.state === "awaiting_confirmation"
      )
        return { state: "running" };
      return;
    }
    if (completedStates.includes(record.publication.state))
      return {
        state:
          record.publication.state === "published"
            ? "completed"
            : record.publication.state === "rejected"
              ? "failed"
              : (record.publication.state as
                  "failed" | "cancelled" | "uncertain"),
      };
    return;
  }
  hasProtectedAssets(): boolean {
    return this.deps.store.list(true).some((t) => t.type === "publication");
  }
}
