/// <reference lib="dom" />

import {
  PlatformAccount,
  type PlatformAccountInfoItem,
  type PlatformAccountSnapshot,
} from "../domain/index.js";
import type {
  PlatformAccountProfileData,
  PlatformModule,
} from "@nedia-matrix/platform-sdk";

import {
  AccountIdentityService,
  type SessionDetection,
} from "./account-identity-service.js";
import type {
  AccountRepository,
  AccountDiagnosticPort,
  AccountDiagnosticTrace,
  BrowserSessionPort,
  PlatformCatalog,
  SessionDetectionPort,
} from "./account-ports.js";
import type {
  CreatePlatformAccountRequest,
  OpenPlatformLoginRequest,
  PlatformAccountRequest,
  ResolvedPlatformAccount,
  PlatformAccountView,
} from "./account-types.js";
import { toPlatformAccountView } from "./account-types.js";
import {
  assertAccountRequest,
  assertLoginRequest,
  assertPlatformRequest,
} from "./account-request-validator.js";
import { RetiredProfileCleaner } from "./retired-profile-cleaner.js";

const AUTOMATIC_RECOGNITION_INTERVAL_MS = 3_000;
const AUTOMATIC_RECOGNITION_MAX_ATTEMPTS = 100;

type OpenedAccountSession = Awaited<
  ReturnType<BrowserSessionPort["openUserPage"]>
>;

function waitForRecognition(intervalMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, intervalMs);
    unrefTimer(timer);
  });
}

function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}

function profileItems(
  profile: PlatformAccountProfileData,
): PlatformAccountInfoItem[] {
  return [
    ...(profile.description === undefined
      ? []
      : [{ key: "desc" as const, value: profile.description }]),
    ...(profile.followerCount === undefined
      ? []
      : [{ key: "follower_count" as const, value: profile.followerCount }]),
    ...(profile.followingCount === undefined
      ? []
      : [{ key: "following_count" as const, value: profile.followingCount }]),
    ...(profile.contentCount === undefined
      ? []
      : [{ key: "content_count" as const, value: profile.contentCount }]),
    ...(profile.likeCount === undefined
      ? []
      : [{ key: "like_count" as const, value: profile.likeCount }]),
  ];
}

export interface AccountServiceDependencies {
  platforms: PlatformCatalog;
  accountStore: AccountRepository;
  browserSessions: BrowserSessionPort;
  removeAccountResources(account: PlatformAccountSnapshot): Promise<void>;
  isAccountBusy?(accountId: string): boolean;
  createId(): string;
  createProfileId(platformId: string, accountId: string): string;
  now?: (() => Date) | undefined;
  sessionDetector: SessionDetectionPort["detect"];
  onAccountsChanged?: (() => void) | undefined;
  recognitionIntervalMs?: number | undefined;
  recognitionMaxAttempts?: number | undefined;
  diagnostics?: AccountDiagnosticPort | undefined;
}

export class AccountReplacedError extends Error {
  constructor(readonly survivingAccountId: string) {
    super("Platform account was replaced by an existing account");
  }
}

export class PlatformAccountIdentityError extends Error {
  constructor(
    readonly code:
      | "ACCOUNT_NOT_FOUND"
      | "ACCOUNT_AMBIGUOUS"
      | "NOT_LOGGED_IN"
      | "ACCOUNT_IDENTITY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "PlatformAccountIdentityError";
  }
}

export class AccountService {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly sessionDetector: SessionDetectionPort["detect"];
  private readonly recognitionTokens = new Map<string, symbol>();
  private readonly recognitionCancels = new Map<string, () => void>();
  private readonly verificationTransitions = new Map<string, Promise<void>>();
  private readonly recognitionIntervalMs: number;
  private readonly recognitionMaxAttempts: number;
  private readonly retiredProfiles: RetiredProfileCleaner;
  private readonly identities: AccountIdentityService;
  private readonly deleting = new Set<string>();

  constructor(private readonly dependencies: AccountServiceDependencies) {
    this.createId = dependencies.createId;
    this.now = dependencies.now ?? (() => new Date());
    this.sessionDetector = dependencies.sessionDetector;
    this.recognitionIntervalMs =
      dependencies.recognitionIntervalMs ?? AUTOMATIC_RECOGNITION_INTERVAL_MS;
    this.recognitionMaxAttempts =
      dependencies.recognitionMaxAttempts ?? AUTOMATIC_RECOGNITION_MAX_ATTEMPTS;
    this.retiredProfiles = new RetiredProfileCleaner({
      accountStore: dependencies.accountStore,
      browserSessions: dependencies.browserSessions,
      now: this.now,
      diagnostics: dependencies.diagnostics,
      createId: this.createId,
    });
    this.identities = new AccountIdentityService({
      platforms: dependencies.platforms,
      accountStore: dependencies.accountStore,
      browserSessions: dependencies.browserSessions,
      retiredProfiles: this.retiredProfiles,
      now: this.now,
      isAccountBusy: dependencies.isAccountBusy,
      onAccountsChanged: dependencies.onAccountsChanged,
      cancelRecognition: (accountId) =>
        this.cancelAutomaticRecognition(accountId),
    });
  }

  listAccounts(): PlatformAccountView[] {
    return this.dependencies.accountStore.list().map(toPlatformAccountView);
  }

  resolveAccount(request: PlatformAccountRequest): ResolvedPlatformAccount {
    assertAccountRequest(request);
    const resolved = this.dependencies.accountStore.resolve(
      request.accountId,
      this.now(),
    );
    this.assertAvailable(resolved.account.id);
    return resolved;
  }

  resolveByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
  }): PlatformAccountSnapshot {
    if (
      typeof request.platformId !== "string" ||
      request.platformId.length === 0 ||
      typeof request.externalAccountId !== "string" ||
      request.externalAccountId.length === 0
    ) {
      throw new TypeError("Invalid platform account identity");
    }
    const matches = this.dependencies.accountStore
      .list()
      .filter(
        (account) =>
          account.lifecycle === "active" &&
          account.platformId === request.platformId &&
          account.externalAccountId === request.externalAccountId,
      );
    if (matches.length === 0) {
      throw new PlatformAccountIdentityError(
        "ACCOUNT_NOT_FOUND",
        "No local account matches the platform identity",
      );
    }
    if (matches.length > 1) {
      throw new PlatformAccountIdentityError(
        "ACCOUNT_AMBIGUOUS",
        "Multiple local accounts match the platform identity",
      );
    }
    return matches[0]!;
  }

  async verifyByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
  }): Promise<PlatformAccountSnapshot> {
    const account = this.resolveByExternalIdentity(request);
    const detected = await this.verifyAccount({ accountId: account.id });
    if (detected.status === "login_required") {
      throw new PlatformAccountIdentityError(
        "NOT_LOGGED_IN",
        "Runtime account is not authenticated",
      );
    }
    if (detected.status === "unknown") {
      throw new PlatformAccountIdentityError(
        "ACCOUNT_IDENTITY_MISMATCH",
        detected.reason,
      );
    }
    if (
      detected.externalAccountId !== request.externalAccountId ||
      detected.status !== "authenticated"
    ) {
      throw new PlatformAccountIdentityError(
        "ACCOUNT_IDENTITY_MISMATCH",
        "Runtime account identity does not match the requested platform identity",
      );
    }
    const current = this.dependencies.accountStore.get(account.id);
    if (
      !current ||
      current.lifecycle !== "active" ||
      current.platformId !== request.platformId ||
      current.externalAccountId !== request.externalAccountId
    ) {
      throw new PlatformAccountIdentityError(
        "ACCOUNT_IDENTITY_MISMATCH",
        "Runtime account identity does not match the requested platform identity",
      );
    }
    return current;
  }

  createAccount(request: CreatePlatformAccountRequest): PlatformAccountView {
    assertPlatformRequest(request);
    const platform = this.dependencies.platforms.require(request.platformId);
    const id = this.createId();
    const now = this.now().toISOString();
    const account = PlatformAccount.createPending({
      id,
      platformId: platform.id,
      profileId: this.dependencies.createProfileId(platform.id, id),
      platformDisplayName: platform.displayName,
      occurredAt: now,
    }).toSnapshot();
    this.dependencies.accountStore.put(account);
    this.dependencies.onAccountsChanged?.();
    return toPlatformAccountView(account);
  }

  async openLogin(request: OpenPlatformLoginRequest) {
    assertLoginRequest(request);
    this.assertAvailable(request.accountId);
    const { account } = this.resolveAccount(request);
    if (this.dependencies.isAccountBusy?.(account.id))
      throw new Error("账号正在发布，请结束任务后再登录");
    const platform = this.dependencies.platforms.require(account.platformId);
    const loginEntry = platform.accounts.loginEntries.find(
      (entry) => entry.id === request.loginEntryId,
    );
    if (!loginEntry) {
      throw new TypeError(
        `Unknown platform login entry: ${request.loginEntryId}`,
      );
    }
    const trace = this.startDiagnosticTrace(
      "account.browser_open",
      account.id,
      platform.id,
    );
    try {
      const opened = await this.dependencies.browserSessions.openForLogin(
        account,
        platform,
        loginEntry,
        trace,
      );
      this.startAutomaticRecognition(account.id, platform, opened);
      this.finishDiagnostic(trace, { outcome: "completed" });
      return { profileId: account.profileId };
    } catch (error) {
      this.reportBrowserOpenFailure(trace, error);
      throw error;
    }
  }

  async openAccount(request: PlatformAccountRequest) {
    assertAccountRequest(request);
    this.assertAvailable(request.accountId);
    const { account } = this.resolveAccount(request);
    const platform = this.dependencies.platforms.require(account.platformId);
    const loginEntry = platform.accounts.loginEntries[0];
    const trace = this.startDiagnosticTrace(
      "account.browser_open",
      account.id,
      platform.id,
    );
    try {
      const opened =
        account.status !== "authenticated" &&
        loginEntry &&
        !this.dependencies.isAccountBusy?.(account.id)
          ? await this.dependencies.browserSessions.openForLogin(
              account,
              platform,
              loginEntry,
              trace,
            )
          : await this.dependencies.browserSessions.openUserPage(
              account,
              platform,
              trace,
            );
      this.startAutomaticRecognition(account.id, platform, opened);
      this.finishDiagnostic(trace, { outcome: "completed" });
      return { sessionId: opened.id, profileId: opened.profileId };
    } catch (error) {
      this.reportBrowserOpenFailure(trace, error);
      throw error;
    }
  }

  async refreshAccount(request: PlatformAccountRequest) {
    return this.detectAccount(request, true);
  }

  async refreshAccountProfile(
    request: PlatformAccountRequest,
  ): Promise<PlatformAccountView> {
    assertAccountRequest(request);
    this.assertAvailable(request.accountId);
    const { account } = this.resolveAccount(request);
    if (account.lifecycle !== "active" || account.externalAccountId === null) {
      throw new Error("请先完成平台账号登录识别");
    }
    const platform = this.dependencies.platforms.require(account.platformId);
    const trace = this.startDiagnosticTrace(
      "account.profile_refresh",
      account.id,
      account.platformId,
    );
    try {
      const accountProfile = platform.accountProfile;
      if (!accountProfile) throw new Error("该平台暂不支持账号资料刷新");
      const profile = await this.withVerificationTransition(
        account.id,
        async () => {
          const verification =
            await this.dependencies.browserSessions.openForVerification(
              account,
              platform,
              trace,
            );
          try {
            this.reportDiagnostic(trace, {
              component: "session",
              event: "session.detection.started",
              details: { phase: "account_profile_refresh" },
            });
            const detected = await this.sessionDetector(
              platform.accounts.detection,
              verification.driver,
              verification.sessionProbeClient,
            );
            this.reportDiagnostic(trace, {
              component: "session",
              event: "session.detection.completed",
              details: {
                phase: "account_profile_refresh",
                status: detected.status,
              },
            });
            const verified = this.identities.recordEstablished(
              this.dependencies.accountStore.require(account.id),
              detected,
            );
            if (verified.status !== "authenticated") {
              throw new Error(
                verified.status === "login_required"
                  ? "平台账号未登录"
                  : verified.reason,
              );
            }
            this.reportDiagnostic(trace, {
              component: "account",
              event: "account.profile_reader.started",
            });
            const result = await accountProfile.read(verification.dataClient);
            this.reportDiagnostic(trace, {
              component: "account",
              event: "account.profile_reader.completed",
              details: { count: profileItems(result).length },
            });
            return result;
          } finally {
            await verification.close();
          }
        },
      );
      this.assertAvailable(account.id);
      const current = this.dependencies.accountStore.require(account.id);
      if (
        current.identityScheme !== account.identityScheme ||
        current.externalAccountId !== account.externalAccountId
      ) {
        throw new Error("账号身份在资料刷新期间发生变化");
      }
      const aggregate = PlatformAccount.rehydrate(current);
      aggregate.updateProfile(profileItems(profile), this.now().toISOString());
      const snapshot = aggregate.toSnapshot();
      this.dependencies.accountStore.put(snapshot);
      this.reportDiagnostic(trace, {
        component: "account",
        event: "account.profile.persisted",
        details: { count: snapshot.accountInfo?.length ?? 0 },
      });
      this.finishDiagnostic(trace, { outcome: "completed" });
      this.dependencies.onAccountsChanged?.();
      return toPlatformAccountView(snapshot);
    } catch (error) {
      this.reportDiagnostic(trace, {
        component: "account",
        event: "account.profile_refresh.failed",
        level: "error",
        details: {
          code: "ACCOUNT_PROFILE_REFRESH_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : "账号资料刷新失败",
        },
      });
      this.finishDiagnostic(trace, {
        outcome: "failed",
        message: error instanceof Error ? error.message : "账号资料刷新失败",
      });
      throw error;
    }
  }

  updateContentCount(
    accountId: string,
    contentCount: number,
    observedAt: string,
  ): PlatformAccountView {
    this.assertAvailable(accountId);
    const aggregate = PlatformAccount.rehydrate(
      this.dependencies.accountStore.require(accountId),
    );
    aggregate.updateContentCount(contentCount, observedAt);
    const snapshot = aggregate.toSnapshot();
    this.dependencies.accountStore.put(snapshot);
    this.dependencies.onAccountsChanged?.();
    return toPlatformAccountView(snapshot);
  }

  async verifyAccount(request: PlatformAccountRequest) {
    return this.detectAccount(request, false);
  }

  async removeAccount(request: PlatformAccountRequest) {
    assertAccountRequest(request);
    this.assertAvailable(request.accountId);
    if (this.dependencies.isAccountBusy?.(request.accountId))
      throw new Error("账号正在发布，暂不能删除");
    this.cancelAutomaticRecognition(request.accountId);
    const resolved = this.dependencies.accountStore.resolve(
      request.accountId,
      this.now(),
    );
    if (resolved.replacementAlias) {
      throw new AccountReplacedError(resolved.account.id);
    }
    const account = resolved.account;
    this.dependencies.platforms.require(account.platformId);
    this.deleting.add(account.id);
    try {
      await this.dependencies.removeAccountResources(account);
      this.dependencies.onAccountsChanged?.();
    } finally {
      this.deleting.delete(account.id);
    }
  }

  cleanupRetiredProfiles(): Promise<void> {
    return this.retiredProfiles.cleanupDue();
  }

  private async detectAccount(
    request: PlatformAccountRequest,
    allowIdentityChange: boolean,
  ): Promise<SessionDetection> {
    assertAccountRequest(request);
    this.assertAvailable(request.accountId);
    this.cancelAutomaticRecognition(request.accountId);
    const { account } = this.resolveAccount(request);
    this.cancelAutomaticRecognition(account.id);
    const platform = this.dependencies.platforms.require(account.platformId);
    const trace = this.startDiagnosticTrace(
      "account.verify",
      account.id,
      account.platformId,
    );
    try {
      this.reportDiagnostic(trace, {
        component: "session",
        event: "session.detection.started",
        details: {
          phase: allowIdentityChange ? "identity_refresh" : "identity_verify",
        },
      });
      const detected: SessionDetection = await this.withVerificationTransition(
        account.id,
        async () => {
          const verification =
            await this.dependencies.browserSessions.openForVerification(
              account,
              platform,
              trace,
            );
          try {
            return await this.sessionDetector(
              platform.accounts.detection,
              verification.driver,
              verification.sessionProbeClient,
            );
          } finally {
            await verification.close();
          }
        },
      ).catch((error: unknown): SessionDetection => {
        this.reportDiagnostic(trace, {
          component: "session",
          event: "session.detection.failed",
          level: "error",
          details: {
            code: "ACCOUNT_DETECTION_FAILED",
            errorName: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : "账号同步失败",
          },
        });
        return {
          status: "unknown",
          reason: error instanceof Error ? error.message : "账号同步失败",
        };
      });
      this.reportDiagnostic(trace, {
        component: "session",
        event: "session.detection.completed",
        details: {
          phase: allowIdentityChange ? "identity_refresh" : "identity_verify",
          status: detected.status,
          ...(detected.status === "unknown" ? {} : { source: detected.source }),
        },
      });

      this.assertAvailable(account.id);
      if (!this.dependencies.accountStore.get(account.id))
        throw new Error("Account was removed during verification");
      let recorded: SessionDetection;
      if (
        account.lifecycle === "pending_identity" &&
        detected.status === "authenticated"
      ) {
        recorded = (
          await this.identities.reconcileCandidate(account.id, detected)
        ).detection;
      } else if (
        allowIdentityChange &&
        !this.dependencies.isAccountBusy?.(account.id)
      ) {
        recorded = this.identities.recordRefresh(account, detected);
      } else {
        recorded = this.identities.recordEstablished(account, detected);
      }
      this.reportDiagnostic(trace, {
        component: "account",
        event: "account.identity.persisted",
        details: { status: recorded.status },
      });
      this.finishDiagnostic(trace, { outcome: recorded.status });
      return recorded;
    } catch (error) {
      this.reportDiagnostic(trace, {
        component: "account",
        event: "account.identity.failed",
        level: "error",
        details: {
          code: "ACCOUNT_IDENTITY_PERSIST_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : "账号身份处理失败",
        },
      });
      this.finishDiagnostic(trace, {
        outcome: "failed",
        message: error instanceof Error ? error.message : "账号身份处理失败",
      });
      throw error;
    }
  }

  private startDiagnosticTrace(
    operation:
      "account.verify" | "account.profile_refresh" | "account.browser_open",
    accountId: string,
    platformId: string,
  ): AccountDiagnosticTrace | undefined {
    try {
      return this.dependencies.diagnostics?.start({
        operation,
        accountId,
        platformId,
        requestId: this.createId(),
      });
    } catch {
      return undefined;
    }
  }

  private reportBrowserOpenFailure(
    trace: AccountDiagnosticTrace | undefined,
    error: unknown,
  ): void {
    this.reportDiagnostic(trace, {
      component: "account",
      event: "account.browser_open.failed",
      level: "error",
      details: {
        code: "ACCOUNT_BROWSER_OPEN_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
        message:
          error instanceof Error && error.name === "BrowserLaunchError"
            ? "All supported browser launch candidates failed"
            : error instanceof Error
              ? error.message
              : "Unable to open account browser",
      },
    });
    this.finishDiagnostic(trace, { outcome: "failed" });
  }

  private reportDiagnostic(
    trace: AccountDiagnosticTrace | undefined,
    event: Parameters<AccountDiagnosticTrace["report"]>[0],
  ): void {
    try {
      trace?.report(event);
    } catch {
      // Diagnostics must not affect account operations.
    }
  }

  private finishDiagnostic(
    trace: AccountDiagnosticTrace | undefined,
    result: Parameters<AccountDiagnosticTrace["finish"]>[0],
  ): void {
    try {
      trace?.finish(result);
    } catch {
      // Diagnostics must not affect account operations.
    }
  }

  private startAutomaticRecognition(
    accountId: string,
    platform: PlatformModule,
    opened: OpenedAccountSession,
  ): void {
    const token = Symbol(accountId);
    this.recognitionTokens.set(accountId, token);
    void this.runAutomaticRecognition(
      accountId,
      platform,
      opened,
      token,
    ).finally(() => {
      if (this.recognitionTokens.get(accountId) === token) {
        this.recognitionTokens.delete(accountId);
      }
      this.recognitionCancels.delete(accountId);
    });
  }

  private async runAutomaticRecognition(
    accountId: string,
    platform: PlatformModule,
    opened: OpenedAccountSession,
    token: symbol,
  ): Promise<void> {
    if (
      platform.accounts.detection.probes.some(
        (probe) => probe.source.kind === "observed-response",
      ) &&
      typeof opened.sessionProbeClient.subscribeObservedResponses === "function"
    ) {
      return this.runObservedResponseRecognition(
        accountId,
        platform,
        opened,
        token,
      );
    }
    for (
      let attempt = 1;
      attempt <= this.recognitionMaxAttempts;
      attempt += 1
    ) {
      if (
        this.recognitionTokens.get(accountId) !== token ||
        opened.page.isClosed()
      ) {
        return;
      }

      let detected: SessionDetection | undefined;
      try {
        detected = await this.sessionDetector(
          platform.accounts.detection,
          opened.driver,
          opened.sessionProbeClient,
        );
      } catch {
        // Page transitions are expected while the user completes login.
      }
      if (this.recognitionTokens.get(accountId) !== token) return;
      if (detected?.status === "authenticated") {
        const account = this.dependencies.accountStore.get(accountId);
        if (!account) return;
        if (account.lifecycle === "pending_identity") {
          const result = await this.identities.reconcileCandidate(
            accountId,
            detected,
          );
          if (!result.retry) return;
        } else {
          this.identities.recordEstablished(account, detected);
          return;
        }
      }
      if (attempt === this.recognitionMaxAttempts || opened.page.isClosed()) {
        if (detected) this.identities.persistAutomatic(accountId, detected);
        return;
      }
      await waitForRecognition(this.recognitionIntervalMs);
    }
  }

  private runObservedResponseRecognition(
    accountId: string,
    platform: PlatformModule,
    opened: OpenedAccountSession,
    token: symbol,
  ): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      let inspecting = false;
      let inspectAgain = false;
      let lastDetected: SessionDetection | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const observedTimeoutMs = platform.accounts.detection.probes.reduce(
        (total, probe) =>
          total +
          (probe.source.kind === "observed-response"
            ? probe.source.timeoutMs
            : 0),
        0,
      );
      const deadlineMs =
        this.recognitionMaxAttempts *
        (this.recognitionIntervalMs + observedTimeoutMs);

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadlineTimer);
        if (retryTimer) clearTimeout(retryTimer);
        unsubscribeResponses();
        if (typeof opened.page.off === "function") {
          opened.page.off("close", finish);
        }
        resolve();
      };

      const reconcile = async (
        detected: Extract<SessionDetection, { status: "authenticated" }>,
      ) => {
        const account = this.dependencies.accountStore.get(accountId);
        if (!account) return finish();
        if (account.lifecycle !== "pending_identity") {
          this.identities.recordEstablished(account, detected);
          return finish();
        }
        const result = await this.identities.reconcileCandidate(
          accountId,
          detected,
        );
        if (!result.retry) return finish();
        retryTimer = setTimeout(
          () => void reconcile(detected),
          this.recognitionIntervalMs,
        );
        unrefTimer(retryTimer);
      };

      const inspect = async () => {
        if (finished || this.recognitionTokens.get(accountId) !== token) {
          return finish();
        }
        if (inspecting) {
          inspectAgain = true;
          return;
        }
        inspecting = true;
        try {
          do {
            inspectAgain = false;
            try {
              lastDetected = await this.sessionDetector(
                platform.accounts.detection,
                opened.driver,
                opened.sessionProbeClient,
              );
            } catch {
              lastDetected = undefined;
            }
            if (lastDetected?.status === "authenticated") {
              await reconcile(lastDetected);
              return;
            }
          } while (inspectAgain && !finished);
        } finally {
          inspecting = false;
        }
      };

      const unsubscribeResponses =
        opened.sessionProbeClient.subscribeObservedResponses(() => {
          void inspect();
        });
      if (typeof opened.page.once === "function") {
        opened.page.once("close", finish);
      }
      const deadlineTimer = setTimeout(() => {
        if (lastDetected) {
          this.identities.persistAutomatic(accountId, lastDetected);
        }
        finish();
      }, deadlineMs);
      unrefTimer(deadlineTimer);
      this.recognitionCancels.set(accountId, finish);
      void inspect();
    });
  }

  private cancelAutomaticRecognition(accountId: string): void {
    this.recognitionCancels.get(accountId)?.();
    this.recognitionCancels.delete(accountId);
    this.recognitionTokens.delete(accountId);
  }

  private assertAvailable(accountId: string): void {
    if (this.deleting.has(accountId))
      throw new Error("Account is being removed");
  }

  private async withVerificationTransition<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.verificationTransitions.get(accountId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.verificationTransitions.set(accountId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.verificationTransitions.get(accountId) === queued) {
        this.verificationTransitions.delete(accountId);
      }
    }
  }
}
