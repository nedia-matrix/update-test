import { resolveAccountPlatform } from "@nedia-matrix/platform-sdk";
import { randomUUID } from "node:crypto";
import {
  createBrowserProfileId,
  fingerprintBrowserVersion,
} from "@nedia-matrix/automation-playwright";
import { detectPlatformSession } from "@nedia-matrix/automation-engine";
import {
  accountBrowserSwitchDetection,
  type AccountRepository,
  type AccountBrowserSwitchRepository,
  type AccountBrowserSwitchOperation,
  type AccountBrowserPage,
  type AccountDiagnosticPort,
  type AccountDiagnosticTrace,
  type BrowserSessionPort,
  type PlatformCatalog,
  type PlatformAccountSnapshot,
} from "@nedia-matrix/account-management";
import type {
  AccountBrowserState,
  AccountBrowserSwitchStatus,
  BeginAccountBrowserSwitchRequest,
} from "../../../bridge/account-browser-switch.js";

type Policy = {
  describeProfile(
    profileId: string,
  ): Promise<
    Pick<AccountBrowserState, "provider" | "externalKernel" | "version">
  >;
  initializeSwitchProfile(
    profileId: string,
    provider: "system" | "fingerprint",
  ): void;
};
interface Dependencies {
  accounts: AccountRepository;
  operations: AccountBrowserSwitchRepository;
  platforms: PlatformCatalog;
  policy: Policy;
  browser: Pick<BrowserSessionPort, "openForLogin" | "closeAutomation"> & {
    isAccountBrowserBusy(accountId: string, profileId: string): boolean;
    acquireAccountBrowserSwitch(
      accountId: string,
      originalProfileId: string,
      candidateProfileId: string,
    ): () => void;
    invalidateProfileChannels(...profileIds: string[]): void;
  };
  acquireAccount(accountId: string): () => void;
  assertFingerprintReady(): Promise<void>;
  onChanged(): void;
  cleanup(): Promise<void>;
  diagnostics?: AccountDiagnosticPort;
  detect?: typeof detectPlatformSession;
  createId?: () => string;
  now?: () => Date;
  wait?: (page: AccountBrowserPage, signal: AbortSignal) => Promise<void>;
}
interface Task {
  operation: AccountBrowserSwitchOperation;
  state: AccountBrowserSwitchStatus;
  controller: AbortController;
  done: Promise<void>;
  trace?: AccountDiagnosticTrace;
}

function pause(page: AccountBrowserPage, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2_000);
    unsubscribe = page.sessionProbeClient.subscribeObservedResponses(finish);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Only this use case opens targeted candidates; AccountService never sees them. */
export class AccountBrowserSwitchService {
  private readonly tasks = new Map<string, Task>();
  private readonly beginnings = new Map<
    string,
    Promise<AccountBrowserSwitchStatus>
  >();
  private readonly terminal = new Map<string, AccountBrowserSwitchStatus>();
  private stopping = false;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private cleanupTask: Promise<void> | undefined;
  constructor(private readonly dependencies: Dependencies) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }
  private cleanup(): void {
    if (this.stopping || this.cleanupTask) return;
    this.cleanupTask = Promise.resolve()
      .then(() => this.dependencies.cleanup())
      .catch(() => undefined)
      .finally(() => {
        this.cleanupTask = undefined;
      });
  }
  private transition(
    task: Task,
    phase: AccountBrowserSwitchStatus["phase"],
  ): void {
    task.state.phase = phase;
    try {
      task.trace?.report({
        component: "account",
        event: "account.browser_switch.phase",
        details: {
          phase,
          provider: task.operation.targetProvider,
          ...(task.operation.targetProvider === "fingerprint"
            ? { version: fingerprintBrowserVersion }
            : {}),
        },
      });
    } catch {
      /* diagnostics never change the outcome */
    }
  }
  private now(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
  private changed(): void {
    try {
      this.dependencies.onChanged();
    } catch {
      /* notification is outside commit */
    }
  }

  async accountState(accountId: string): Promise<AccountBrowserState> {
    this.assertId(accountId);
    const account = this.dependencies.accounts.require(accountId);
    const actual = await this.dependencies.policy.describeProfile(
      account.profileId,
    );
    if (
      this.dependencies.accounts.require(accountId).profileId !==
      account.profileId
    )
      return this.accountState(accountId);
    let support: ReturnType<typeof accountBrowserSwitchDetection>;
    try {
      support = accountBrowserSwitchDetection(
        resolveAccountPlatform(this.dependencies.platforms, account),
        account,
      );
    } catch {
      support = {
        supported: false,
        reason: "平台插件不可用，暂不能切换浏览器环境",
      };
    }
    const operation = [...this.tasks.values()].find(
      (task) => task.operation.accountId === accountId,
    );
    const persisted = this.dependencies.operations
      .list()
      .find(
        (item) =>
          item.accountId === accountId &&
          (item.phase === "preparing" || item.phase === "awaiting_login"),
      );
    return {
      accountId,
      ...actual,
      switchSupported: support.supported,
      ...(!support.supported
        ? { blockingReason: support.reason }
        : this.dependencies.browser.isAccountBrowserBusy(
              accountId,
              account.profileId,
            )
          ? { blockingReason: "账号仍有活动任务或人工页面，请先关闭相关页面" }
          : {}),
      ...(operation
        ? { operation: structuredClone(operation.state) }
        : persisted
          ? { operation: this.get(persisted.operationId) }
          : {}),
    };
  }

  begin(
    request: BeginAccountBrowserSwitchRequest,
  ): Promise<AccountBrowserSwitchStatus> {
    this.assertId(request?.accountId);
    if (
      request.targetProvider !== "system" &&
      request.targetProvider !== "fingerprint"
    )
      return Promise.reject(new TypeError("Invalid target provider"));
    if (this.stopping) return Promise.reject(new Error("应用正在退出"));
    const task = [...this.tasks.values()].find(
      (item) => item.operation.accountId === request.accountId,
    );
    if (task) {
      if (task.operation.targetProvider !== request.targetProvider)
        return Promise.reject(new Error("请先完成或取消当前切换"));
      return Promise.resolve(structuredClone(task.state));
    }
    const beginning = this.beginnings.get(request.accountId);
    if (beginning)
      return beginning.then((state) => {
        if (state.targetProvider !== request.targetProvider)
          throw new Error("请先完成或取消当前切换");
        return state;
      });
    const pending = this.start(request);
    this.beginnings.set(request.accountId, pending);
    void pending.then(
      () => this.beginnings.delete(request.accountId),
      () => this.beginnings.delete(request.accountId),
    );
    return pending;
  }

  private async start(
    request: BeginAccountBrowserSwitchRequest,
  ): Promise<AccountBrowserSwitchStatus> {
    const initial = this.dependencies.accounts.require(request.accountId);
    const initialRuntime = await this.dependencies.policy.describeProfile(
      initial.profileId,
    );
    if (this.stopping) throw new Error("应用正在退出");
    if (
      initialRuntime.provider === request.targetProvider &&
      this.dependencies.accounts.require(request.accountId).profileId ===
        initial.profileId
    )
      return {
        accountId: initial.id,
        targetProvider: request.targetProvider,
        phase: "unchanged",
      };
    const releaseAccount = this.dependencies.acquireAccount(request.accountId);
    let releaseBrowser: (() => void) | undefined;
    try {
      const account = this.dependencies.accounts.require(request.accountId);
      const actual = await this.dependencies.policy.describeProfile(
        account.profileId,
      );
      if (this.stopping) throw new Error("应用正在退出");
      if (actual.provider === request.targetProvider)
        return {
          accountId: account.id,
          targetProvider: request.targetProvider,
          phase: "unchanged",
        };
      const unfinished = this.dependencies.operations
        .list()
        .find(
          (item) =>
            item.accountId === account.id &&
            (item.phase === "preparing" || item.phase === "awaiting_login"),
        );
      if (unfinished)
        throw new Error("上次切换尚未完成清理，请先取消或重启应用");
      const support = accountBrowserSwitchDetection(
        resolveAccountPlatform(this.dependencies.platforms, account),
        account,
      );
      if (!support.supported) throw new Error(support.reason);
      if (request.targetProvider === "fingerprint")
        await this.dependencies.assertFingerprintReady();
      if (this.stopping) throw new Error("应用正在退出");
      const operationId = this.dependencies.createId?.() ?? randomUUID();
      const candidateProfileId = createBrowserProfileId(
        account.platformId,
        operationId,
      );
      releaseBrowser = this.dependencies.browser.acquireAccountBrowserSwitch(
        account.id,
        account.profileId,
        candidateProfileId,
      );
      const at = this.now();
      const operation: AccountBrowserSwitchOperation = {
        operationId,
        accountId: account.id,
        originalProfileId: account.profileId,
        candidateProfileId,
        targetProvider: request.targetProvider,
        identity: {
          platformId: account.platformId,
          identityScheme: account.identityScheme!,
          externalAccountId: account.externalAccountId!,
        },
        phase: "preparing",
        createdAt: at,
        updatedAt: at,
      };
      this.dependencies.operations.create(operation);
      const task: Task = {
        operation,
        state: this.fromRecord(operation),
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      try {
        task.trace = this.dependencies.diagnostics?.start({
          operation: "account.browser_switch",
          accountId: account.id,
          platformId: account.platformId,
          requestId: operationId,
        });
      } catch {
        /* diagnostics are optional */
      }
      this.transition(task, "preparing");
      this.tasks.set(operationId, task);
      const release = releaseBrowser;
      // Transfer both leases to the worker, including its final Context cleanup.
      task.done = this.run(task, account, support.plan).finally(() => {
        release();
        releaseAccount();
        this.tasks.delete(operationId);
        this.terminal.set(operationId, structuredClone(task.state));
        if (this.terminal.size > 256)
          this.terminal.delete(this.terminal.keys().next().value!);
        this.transition(task, task.state.phase);
        try {
          task.trace?.finish({
            outcome: task.state.phase,
            ...(task.state.error ? { message: task.state.error.message } : {}),
          });
        } catch {
          /* commit is already settled */
        }
        this.changed();
        this.cleanup();
      });
      void task.done.catch(() => undefined);
      this.changed();
      return structuredClone(task.state);
    } catch (error) {
      releaseBrowser?.();
      releaseAccount();
      throw error;
    } finally {
      // A no-op switch has no worker to release its reservation.
      if (
        ![...this.tasks.values()].some(
          (task) => task.operation.accountId === request.accountId,
        )
      )
        releaseAccount();
    }
  }

  private async run(
    task: Task,
    account: PlatformAccountSnapshot,
    plan: Parameters<typeof detectPlatformSession>[0],
  ): Promise<void> {
    const { operation, controller } = task;
    const candidate = { ...account, profileId: operation.candidateProfileId };
    let detachClose = () => {};
    let candidateClosed = false;
    let committed = false;
    try {
      this.dependencies.policy.initializeSwitchProfile(
        operation.candidateProfileId,
        operation.targetProvider,
      );
      if (controller.signal.aborted) return;
      const platform = resolveAccountPlatform(
        this.dependencies.platforms,
        account,
      );
      const loginEntry = platform.accounts.loginEntries[0];
      if (!loginEntry) throw new Error("Missing login entry");
      const opened = await this.dependencies.browser.openForLogin(
        candidate,
        platform,
        loginEntry,
      );
      const closed = () => controller.abort();
      opened.page.on?.("close", closed);
      detachClose = () => opened.page.off?.("close", closed);
      if (opened.page.isClosed()) controller.abort();
      if (controller.signal.aborted) return;
      this.dependencies.operations.markAwaitingLogin(
        operation.operationId,
        this.now(),
      );
      const expires = Date.now() + 30 * 60_000;
      while (!controller.signal.aborted && Date.now() < expires) {
        if (task.state.phase !== "awaiting_login")
          this.transition(task, "awaiting_login");
        const detected = await (
          this.dependencies.detect ?? detectPlatformSession
        )(plan, opened.driver, opened.sessionProbeClient);
        if (controller.signal.aborted || opened.page.isClosed()) {
          controller.abort();
          break;
        }
        if (detected.status === "authenticated") {
          if (
            detected.identityScheme !== operation.identity.identityScheme ||
            detected.externalAccountId !== operation.identity.externalAccountId
          ) {
            task.state.error = {
              code: "identity_mismatch",
              message:
                "登录的账号与原账号不一致，原环境已保留，请使用原账号重新开始切换",
            };
            break;
          }
          this.transition(task, "verifying");
          const runtime = await this.dependencies.policy.describeProfile(
            candidate.profileId,
          );
          if (runtime.provider !== operation.targetProvider)
            throw new Error("Candidate runtime changed");
          if (controller.signal.aborted) break;
          const current = this.dependencies.accounts.require(account.id);
          if (
            current.profileId !== operation.originalProfileId ||
            current.identityScheme !== operation.identity.identityScheme ||
            current.externalAccountId !==
              operation.identity.externalAccountId ||
            current.platformId !== operation.identity.platformId ||
            this.dependencies.browser.isAccountBrowserBusy(
              account.id,
              account.profileId,
            )
          )
            throw new Error("Original account changed or became busy");
          this.transition(task, "committing");
          await this.dependencies.browser.closeAutomation(account);
          if (controller.signal.aborted) break;
          detachClose();
          await this.dependencies.browser.closeAutomation(candidate);
          candidateClosed = true;
          if (controller.signal.aborted) break;
          const at = this.now();
          this.dependencies.operations.commit({
            operationId: operation.operationId,
            identity: operation.identity,
            nickname: detected.nickname,
            avatarUrl: detected.avatarUrl,
            occurredAt: at,
            removeRetiredProfileAfter: new Date(
              Date.parse(at) + 24 * 60 * 60_000,
            ).toISOString(),
          });
          committed = true;
          this.transition(task, "committed");
          this.dependencies.browser.invalidateProfileChannels(
            account.profileId,
            candidate.profileId,
          );
          break;
        }
        await (this.dependencies.wait ?? pause)(opened, controller.signal);
      }
      if (!committed && !controller.signal.aborted && !task.state.error)
        task.state.error = {
          code: "interrupted",
          message: "登录等待已结束，原账号环境已保留，请重新开始切换",
        };
    } catch {
      if (!controller.signal.aborted && !committed)
        task.state.error = {
          code: "unavailable",
          message:
            "切换未完成，原账号环境已保留。请检查浏览器配置或重新开始切换",
        };
    } finally {
      detachClose();
      try {
        if (!candidateClosed)
          await this.dependencies.browser.closeAutomation(candidate);
        if (!committed)
          this.dependencies.operations.cancel(
            operation.operationId,
            this.now(),
          );
      } catch {
        task.state.error = {
          code: "cleanup",
          message: "新环境尚未完成清理，原环境已保留，请重试取消或重启应用",
        };
      }
      if (!committed)
        task.state.phase = task.state.error ? "failed" : "cancelled";
      else task.state.phase = "committed";
    }
  }

  get(operationId: string): AccountBrowserSwitchStatus {
    this.assertId(operationId);
    const task = this.tasks.get(operationId);
    if (task) return structuredClone(task.state);
    const terminal = this.terminal.get(operationId);
    if (terminal) return structuredClone(terminal);
    const operation = this.dependencies.operations.get(operationId);
    if (!operation) throw new Error("切换操作不存在");
    return this.fromRecord(operation);
  }
  async cancel(operationId: string): Promise<AccountBrowserSwitchStatus> {
    this.assertId(operationId);
    const task = this.tasks.get(operationId);
    if (task) {
      if (
        task.state.phase !== "committing" &&
        task.state.phase !== "committed"
      ) {
        this.transition(task, "cancelling");
        task.controller.abort();
      }
      await task.done;
      return this.get(operationId);
    }
    const operation = this.dependencies.operations.get(operationId);
    if (!operation) throw new Error("切换操作不存在");
    // Also retries cleanup when a previous close or persistence attempt failed.
    if (operation.phase !== "committed") {
      const original = this.dependencies.accounts.get(operation.accountId) ?? {
        id: operation.accountId,
        platformId: operation.identity.platformId,
        profileId: operation.originalProfileId,
        lifecycle: "active" as const,
        displayName: "",
        identityScheme: operation.identity.identityScheme,
        externalAccountId: operation.identity.externalAccountId,
        nickname: null,
        avatarUrl: null,
        accountInfo: [],
        profileSyncedAt: null,
        status: "unknown" as const,
        lastVerifiedAt: null,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      };
      await this.dependencies.browser.closeAutomation({
        ...original,
        profileId: operation.candidateProfileId,
      });
      const cancelled = this.dependencies.operations.cancel(
        operationId,
        this.now(),
      );
      this.terminal.set(operationId, this.fromRecord(cancelled));
      await this.dependencies.cleanup();
      this.changed();
    }
    return this.get(operationId);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.cleanupTimer);
    // Revoke candidates before waiting for unrelated file cleanup or preparation.
    for (const task of this.tasks.values()) task.controller.abort();
    await this.cleanupTask;
    await Promise.allSettled([...this.beginnings.values()]);
    await Promise.allSettled([...this.tasks.values()].map((task) => task.done));
  }
  private fromRecord(
    operation: AccountBrowserSwitchOperation,
  ): AccountBrowserSwitchStatus {
    return {
      operationId: operation.operationId,
      accountId: operation.accountId,
      targetProvider: operation.targetProvider,
      phase: operation.phase,
    };
  }
  private assertId(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value.trim() || value.length > 256)
      throw new TypeError("Invalid account switch identifier");
  }
}
