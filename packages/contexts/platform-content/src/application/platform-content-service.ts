import {
  isAllowedPlatformUrl,
  PlatformSyncError,
  platformSyncFailure,
  resolveAccountPlatform,
  type AccountPlatformCatalog,
  type PlatformContentData,
  type PlatformDataClient,
  type PlatformModule,
  type PlatformSyncFailure,
} from "@nedia-matrix/platform-sdk";
import {
  PlatformContent,
  type PlatformContentSnapshot,
} from "../domain/platform-content.js";

export type PlatformContentSyncStatus = "completed" | "partial" | "failed";

export interface PlatformContentSyncProgress {
  readonly accountId: string;
  readonly runId: string;
  readonly running: boolean;
  readonly pagesRead: number;
  readonly itemsRead: number;
  readonly remoteTotal: number | null;
}

export interface PlatformContentSyncRun {
  readonly id: string;
  readonly accountId: string;
  readonly status: PlatformContentSyncStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly pagesRead: number;
  readonly itemsRead: number;
  readonly remoteTotal: number | null;
  readonly diagnostics: readonly string[];
  readonly failure?: PlatformSyncFailure;
}

export interface PlatformContentRepository {
  listByAccount(accountId: string): PlatformContentSnapshot[];
  findMany(
    accountId: string,
    externalContentIds: readonly string[],
  ): PlatformContentSnapshot[];
  find(
    accountId: string,
    externalContentId: string,
  ): PlatformContentSnapshot | undefined;
  saveAll(
    contents: readonly PlatformContentSnapshot[],
    run: PlatformContentSyncRun,
    /** Full remote inventory; atomically remove absent snapshots only for completed runs. */
    completeExternalContentIds?: readonly string[],
  ): void;
  saveRun(run: PlatformContentSyncRun): void;
  latestRun(accountId: string): PlatformContentSyncRun | undefined;
}

export interface PlatformContentAccount {
  readonly settings?: import("@nedia-matrix/platform-sdk").PlatformSettings;
  readonly id: string;
  readonly platformId: string;
  readonly lifecycle: "pending_identity" | "active";
  readonly status: "authenticated" | "login_required" | "unknown";
  readonly identityScheme: string | null;
  readonly externalAccountId: string | null;
}

export interface PlatformContentServiceDependencies {
  preserveMissing?: boolean;
  accounts: {
    require(accountId: string): PlatformContentAccount;
    updateContentCount(
      accountId: string,
      contentCount: number,
      observedAt: string,
    ): void;
  };
  platforms: AccountPlatformCatalog;
  browser: {
    open(
      accountId: string,
      platform: PlatformModule,
      diagnostics?: PlatformContentAutomationDiagnosticTrace,
    ): Promise<{
      dataClient: PlatformDataClient;
      verify(): Promise<{
        status: "authenticated" | "login_required" | "unknown";
        identityScheme?: string;
        externalAccountId?: string;
        reason?: string;
      }>;
      close(): Promise<void>;
    }>;
  };
  repository: PlatformContentRepository;
  createId(): string;
  now(): Date;
  monotonicNow?: () => number;
  automationDiagnostics?: PlatformContentAutomationDiagnosticPort;
}

export interface PlatformContentAutomationDiagnosticEvent {
  readonly component: "application" | "browser" | "session" | "content";
  readonly event: string;
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PlatformContentAutomationDiagnosticTrace {
  readonly traceId: string;
  bind(binding: { pageId?: string }): void;
  report(event: PlatformContentAutomationDiagnosticEvent): void;
  finish(input: { outcome: string; message?: string }): void;
}

export interface PlatformContentAutomationDiagnosticPort {
  start(input: {
    operation: "content.sync";
    accountId: string;
    platformId: string;
    requestId: string;
  }): PlatformContentAutomationDiagnosticTrace;
}

export class PlatformContentService {
  private readonly syncing = new Map<string, Promise<PlatformContentSyncRun>>();

  private readonly progressListeners = new Map<
    string,
    Set<(progress: PlatformContentSyncProgress) => void>
  >();

  constructor(
    private readonly dependencies: PlatformContentServiceDependencies,
  ) {}

  list(accountId: string): PlatformContentSnapshot[] {
    assertAccountId(accountId);
    return this.dependencies.repository.listByAccount(accountId);
  }

  findMany(
    accountId: string,
    externalContentIds: readonly string[],
  ): PlatformContentSnapshot[] {
    assertAccountId(accountId);
    if (!Array.isArray(externalContentIds)) {
      throw new TypeError("Platform content IDs must be an array");
    }
    for (const externalContentId of externalContentIds) {
      if (typeof externalContentId !== "string" || !externalContentId.trim()) {
        throw new TypeError("Platform content ID must be a non-empty string");
      }
    }
    return this.dependencies.repository.findMany(accountId, externalContentIds);
  }

  latestRun(accountId: string): PlatformContentSyncRun | undefined {
    assertAccountId(accountId);
    return this.dependencies.repository.latestRun(accountId);
  }

  contentUrl(accountId: string, externalContentId: string): string {
    assertAccountId(accountId);
    if (typeof externalContentId !== "string" || !externalContentId.trim()) {
      throw new TypeError("Invalid external content ID");
    }
    const content = this.dependencies.repository.find(
      accountId,
      externalContentId,
    );
    if (!content?.contentUrl) {
      throw new TypeError("Platform content does not have a URL");
    }
    const platform = this.dependencies.platforms.require(content.platformId);
    if (!isAllowedPlatformUrl(platform.browser, content.contentUrl)) {
      throw new TypeError(
        "Platform content URL is outside the platform boundary",
      );
    }
    return content.contentUrl;
  }

  refresh(
    accountId: string,
    onProgress?: (progress: PlatformContentSyncProgress) => void,
  ): Promise<PlatformContentSyncRun> {
    assertAccountId(accountId);
    if (onProgress) {
      const listeners = this.progressListeners.get(accountId) ?? new Set();
      listeners.add(onProgress);
      this.progressListeners.set(accountId, listeners);
    }
    const active = this.syncing.get(accountId);
    if (active) return active;
    const operation = this.run(accountId).finally(() => {
      if (this.syncing.get(accountId) === operation) {
        this.syncing.delete(accountId);
        this.progressListeners.delete(accountId);
      }
    });
    this.syncing.set(accountId, operation);
    return operation;
  }

  private async run(accountId: string): Promise<PlatformContentSyncRun> {
    const monotonicNow = this.dependencies.monotonicNow ?? (() => Date.now());
    const syncStartedAt = monotonicNow();
    const startedAt = this.dependencies.now().toISOString();
    const runId = this.dependencies.createId();
    let trace: PlatformContentAutomationDiagnosticTrace | undefined;
    let checkpoint: PlatformContentSyncRun | undefined;
    const savedIds = new Set<string>();
    const notify = (running: boolean) => {
      for (const listener of this.progressListeners.get(accountId) ?? []) {
        try {
          listener({
            accountId,
            runId,
            running,
            pagesRead: checkpoint?.pagesRead ?? 0,
            itemsRead: savedIds.size,
            remoteTotal: checkpoint?.remoteTotal ?? null,
          });
        } catch {
          /* A disconnected observer must not interrupt persistence. */
        }
      }
    };
    notify(true);
    try {
      const account = this.dependencies.accounts.require(accountId);
      trace = startDiagnosticTrace(this.dependencies, {
        operation: "content.sync",
        accountId,
        platformId: account.platformId,
        requestId: runId,
      });
      report(trace, {
        component: "content",
        event: "content.sync.started",
      });
      if (
        account.lifecycle !== "active" ||
        account.status !== "authenticated" ||
        account.identityScheme === null ||
        account.externalAccountId === null
      ) {
        throw new PlatformSyncError({
          code: "authentication",
          message: "请先完成平台账号登录识别",
          retryable: false,
        });
      }
      const platform = resolveAccountPlatform(
        this.dependencies.platforms,
        account,
      );
      if (!platform.content)
        throw new PlatformSyncError({
          code: "unsupported",
          message: "该平台暂不支持作品同步",
          retryable: false,
        });
      const opened = await this.dependencies.browser.open(
        accountId,
        platform,
        trace,
      );
      let result;
      try {
        const verificationStartedAt = monotonicNow();
        report(trace, {
          component: "session",
          event: "session.detection.started",
          details: { phase: "content_sync" },
        });
        const verified = await opened.verify();
        report(trace, {
          component: "session",
          event: "session.detection.completed",
          details: {
            phase: "content_sync",
            status: verified.status,
            durationMs: elapsed(verificationStartedAt, monotonicNow()),
          },
        });
        if (
          verified.status !== "authenticated" ||
          verified.identityScheme !== account.identityScheme ||
          verified.externalAccountId !== account.externalAccountId
        ) {
          throw new PlatformSyncError({
            code:
              verified.status === "login_required"
                ? "authentication"
                : verified.status === "unknown"
                  ? "verification_required"
                  : "identity_mismatch",
            message:
              verified.status === "unknown" && verified.reason
                ? verified.reason
                : "当前登录的平台账号与本地记录不一致",
            retryable: false,
          });
        }
        const readerStartedAt = monotonicNow();
        report(trace, {
          component: "content",
          event: "content.reader.started",
          details: {
            implementationStatus: platform.content.implementationStatus,
          },
        });
        result = await platform.content.read(
          opened.dataClient,
          account.externalAccountId,
          {
            onPage: async (page) => {
              this.assertAccountIdentity(accountId, account);
              const observedAt = this.dependencies.now().toISOString();
              const unique = new Map(
                page.items.map((item) => [item.externalContentId, item]),
              );
              const contents = [...unique.values()].map((data) =>
                this.apply(account, data, observedAt),
              );
              const itemsRead =
                savedIds.size +
                [...unique.keys()].filter((id) => !savedIds.has(id)).length;
              const next: PlatformContentSyncRun = {
                id: runId,
                accountId,
                status: "partial",
                startedAt,
                completedAt: observedAt,
                pagesRead: page.pagesRead,
                itemsRead,
                remoteTotal:
                  page.remoteTotal ?? checkpoint?.remoteTotal ?? null,
                diagnostics: ["作品同步尚未完成，已保存读取到的页面"],
              };
              this.dependencies.repository.saveAll(contents, next);
              for (const id of unique.keys()) savedIds.add(id);
              checkpoint = next;
              notify(true);
            },
          },
        );
        for (const message of result.diagnostics ?? []) {
          report(trace, {
            component: "content",
            event: "content.reader.diagnostic",
            level: "warn",
            details: { message },
          });
        }
        report(trace, {
          component: "content",
          event: "content.reader.completed",
          details: {
            complete: result.complete,
            pagesRead: result.pagesRead,
            itemsRead: result.items.length,
            remoteTotal: result.remoteTotal ?? null,
            diagnosticCount: result.diagnostics?.length ?? 0,
            durationMs: elapsed(readerStartedAt, monotonicNow()),
          },
        });
      } finally {
        try {
          await opened.close();
        } catch (error) {
          throw new PlatformSyncError(
            {
              code: "resource_close_failed",
              message: "同步页面关闭失败",
              retryable: false,
              resourcesClosed: false,
            },
            { cause: error },
          );
        }
      }
      this.assertAccountIdentity(accountId, account);
      const observedAt = this.dependencies.now().toISOString();
      const uniqueItems = new Map(
        result.items.map((data) => [data.externalContentId, data]),
      );
      const complete =
        result.complete &&
        result.pagesRead > 0 &&
        (result.remoteTotal === undefined ||
          uniqueItems.size >= result.remoteTotal) &&
        [...savedIds].every((id) => uniqueItems.has(id));
      if (result.remoteTotal !== undefined || complete) {
        this.dependencies.accounts.updateContentCount(
          accountId,
          result.remoteTotal ?? uniqueItems.size,
          observedAt,
        );
      }
      const contents = [...uniqueItems.values()]
        .filter((data) => !savedIds.has(data.externalContentId))
        .map((data) => this.apply(account, data, observedAt));
      const run: PlatformContentSyncRun = {
        id: runId,
        accountId,
        status: complete ? "completed" : "partial",
        startedAt,
        completedAt: observedAt,
        ...(result.failure ? { failure: result.failure } : {}),
        pagesRead: result.pagesRead,
        itemsRead: uniqueItems.size,
        remoteTotal: result.remoteTotal ?? null,
        diagnostics: [
          ...(result.diagnostics ?? []),
          ...(result.complete && !complete
            ? ["作品同步结果不完整，已保留未读取到的本地作品"]
            : []),
        ],
      };
      this.dependencies.repository.saveAll(
        contents,
        run,
        complete && !this.dependencies.preserveMissing
          ? [...uniqueItems.keys()]
          : undefined,
      );
      checkpoint = run;
      for (const id of uniqueItems.keys()) savedIds.add(id);
      report(trace, {
        component: "content",
        event: "content.sync.persisted",
        details: {
          status: run.status,
          pagesRead: run.pagesRead,
          itemsRead: run.itemsRead,
          remoteTotal: run.remoteTotal,
          diagnosticCount: run.diagnostics.length,
          durationMs: elapsed(syncStartedAt, monotonicNow()),
        },
      });
      finish(trace, { outcome: run.status });
      return run;
    } catch (error) {
      const run: PlatformContentSyncRun = {
        id: runId,
        accountId,
        status: "failed",
        startedAt,
        completedAt: this.dependencies.now().toISOString(),
        pagesRead: checkpoint?.pagesRead ?? 0,
        itemsRead: savedIds.size,
        remoteTotal: checkpoint?.remoteTotal ?? null,
        failure: platformSyncFailure(error),
        diagnostics: [
          (error instanceof Error ? error.message : "作品同步失败") +
            (savedIds.size > 0
              ? `（已保留 ${checkpoint?.pagesRead ?? 0} 页、${savedIds.size} 条作品）`
              : ""),
        ],
      };
      try {
        this.dependencies.repository.saveRun(run);
      } catch (persistenceError) {
        report(trace, {
          component: "content",
          event: "content.sync.failure_record_persist_failed",
          level: "error",
          details: {
            code: "SYNC_FAILURE_RECORD_PERSIST_FAILED",
            errorName:
              persistenceError instanceof Error
                ? persistenceError.name
                : "UnknownError",
            message:
              persistenceError instanceof Error
                ? persistenceError.message
                : "Unable to save failed sync run",
          },
        });
        finish(trace, { outcome: "failed" });
        throw new PlatformSyncError(
          {
            code: "persistence_failed",
            message: "同步结果持久化失败",
            retryable: false,
            resourcesClosed: run.failure?.resourcesClosed !== false,
          },
          { cause: persistenceError },
        );
      }
      report(trace, {
        component: "content",
        event: "content.sync.failed",
        level: "error",
        details: {
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : "作品同步失败",
          durationMs: elapsed(syncStartedAt, monotonicNow()),
        },
      });
      finish(trace, {
        outcome: "failed",
      });
      return run;
    } finally {
      notify(false);
    }
  }

  private assertAccountIdentity(
    accountId: string,
    account: PlatformContentAccount,
  ): void {
    const current = this.dependencies.accounts.require(accountId);
    if (
      current.platformId !== account.platformId ||
      current.identityScheme !== account.identityScheme ||
      current.externalAccountId !== account.externalAccountId
    ) {
      throw new Error("账号身份在作品同步期间发生变化");
    }
  }

  private apply(
    account: PlatformContentAccount,
    data: PlatformContentData,
    observedAt: string,
  ): PlatformContentSnapshot {
    const existing = this.dependencies.repository.find(
      account.id,
      data.externalContentId,
    );
    if (existing) {
      const aggregate = PlatformContent.rehydrate(existing);
      aggregate.observe(data, observedAt);
      return aggregate.toSnapshot();
    }
    return PlatformContent.create({
      id: this.dependencies.createId(),
      accountId: account.id,
      platformId: account.platformId,
      data,
      observedAt,
    }).toSnapshot();
  }
}

function elapsed(startedAt: number, now: number): number {
  return Math.max(0, now - startedAt);
}

function startDiagnosticTrace(
  dependencies: PlatformContentServiceDependencies,
  input: Parameters<PlatformContentAutomationDiagnosticPort["start"]>[0],
): PlatformContentAutomationDiagnosticTrace | undefined {
  try {
    return dependencies.automationDiagnostics?.start(input);
  } catch {
    return undefined;
  }
}

function report(
  trace: PlatformContentAutomationDiagnosticTrace | undefined,
  event: PlatformContentAutomationDiagnosticEvent,
): void {
  try {
    trace?.report(event);
  } catch {
    // Diagnostics must not affect content synchronization.
  }
}

function finish(
  trace: PlatformContentAutomationDiagnosticTrace | undefined,
  result: { outcome: string; message?: string },
): void {
  try {
    trace?.finish(result);
  } catch {
    // Diagnostics must not affect content synchronization.
  }
}

function assertAccountId(accountId: string): void {
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new TypeError("Platform account ID must be a non-empty string");
  }
}
