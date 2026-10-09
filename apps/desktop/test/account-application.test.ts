import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountService,
  PlatformAccountIdentityError,
  type AccountServiceDependencies,
} from "@nedia-matrix/account-management";
import { AccountStateRepository } from "../src/main/accounts/infrastructure/account-state-repository.js";
import { desktopPlatformRegistry } from "../src/main/platforms/platform-registry.js";

const account: PlatformAccountSnapshot = {
  id: "account-1",
  platformId: "douyin",
  profileId: "matrix-douyin-account-1",
  lifecycle: "pending_identity",
  displayName: "抖音账号",
  identityScheme: null,
  externalAccountId: null,
  nickname: null,
  avatarUrl: null,
  accountInfo: [],
  profileSyncedAt: null,
  status: "login_required",
  lastVerifiedAt: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const accountServiceDefaults = {
  createId: () => "unused-account-id",
  createProfileId: (platformId: string, accountId: string) =>
    `matrix-${platformId}-${accountId}`,
  sessionDetector: async () => ({
    status: "unknown" as const,
    reason: "unused session detector",
  }),
} satisfies Pick<
  AccountServiceDependencies,
  "createId" | "createProfileId" | "sessionDetector"
>;

afterEach(() => vi.useRealTimers());

describe("account application", () => {
  it("finishes a diagnostic trace when the account browser cannot open", async () => {
    const events: string[] = [];
    const trace = {
      traceId: "trace-1",
      bind: () => undefined,
      report: ({ event }: { event: string }) => events.push(event),
      finish: ({ outcome }: { outcome: string }) =>
        events.push(`finish:${outcome}`),
    };
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(new Map([[account.id, account]])),
      browserSessions: {
        openForLogin: async () => {
          throw new Error("browser unavailable");
        },
        openUserPage: async () => openedSession(),
        openForVerification: async () => openedSession(),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      diagnostics: { start: () => trace },
      removeAccountResources: async () => undefined,
    });

    await expect(
      application.openAccount({ accountId: account.id }),
    ).rejects.toThrow("browser unavailable");
    expect(events).toEqual(["account.browser_open.failed", "finish:failed"]);
  });

  it("resolves and verifies an active account by platform identity", async () => {
    const storedAccount: PlatformAccountSnapshot = {
      ...account,
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-42",
      nickname: "账号",
      status: "authenticated",
    };
    const accounts = new Map([[storedAccount.id, storedAccount]]);
    const close = vi.fn(async () => undefined);
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () => ({ ...openedSession(), close }),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      sessionDetector: async () => ({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-42",
        nickname: "账号",
        avatarUrl: null,
        source: "api",
      }),
    });

    expect(
      application.resolveByExternalIdentity({
        platformId: "douyin",
        externalAccountId: "douyin-42",
      }),
    ).toEqual(storedAccount);
    await expect(
      application.verifyByExternalIdentity({
        platformId: "douyin",
        externalAccountId: "douyin-42",
      }),
    ).resolves.toMatchObject({ id: storedAccount.id });
    expect(close).toHaveBeenCalledOnce();

    expect(() =>
      application.resolveByExternalIdentity({
        platformId: "douyin",
        externalAccountId: "missing",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ACCOUNT_NOT_FOUND",
        name: PlatformAccountIdentityError.name,
      }),
    );

    accounts.set("account-2", { ...storedAccount, id: "account-2" });
    expect(() =>
      application.resolveByExternalIdentity({
        platformId: "douyin",
        externalAccountId: "douyin-42",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ACCOUNT_AMBIGUOUS",
        name: PlatformAccountIdentityError.name,
      }),
    );
  });

  it("notifies after account creation and completed removal", async () => {
    const accounts = new Map<string, PlatformAccountSnapshot>();
    let changes = 0;
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () => openedSession(),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async (stored) => {
        accounts.delete(stored.id);
      },
      createId: () => "created-account",
      onAccountsChanged: () => {
        changes += 1;
      },
    });

    const created = application.createAccount({ platformId: "douyin" });
    expect(accounts.get(created.id)).toEqual(created);
    expect(changes).toBe(1);

    await application.removeAccount({ accountId: created.id });
    expect(accounts.has(created.id)).toBe(false);
    expect(changes).toBe(2);
  });

  it("opens the login entry through the unified account action and recognizes the account automatically", async () => {
    vi.useFakeTimers();
    const accounts = new Map([[account.id, { ...account }]]);
    const updates: number[] = [];
    const openForLogin = vi.fn(async () => openedSession());
    const sessionDetector = vi
      .fn()
      .mockResolvedValueOnce({ status: "login_required", source: "api" })
      .mockResolvedValueOnce({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-42",
        nickname: "自动识别账号",
        avatarUrl: null,
        source: "api",
      });
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin,
        openUserPage: async () => openedSession(),
        openForVerification: async () => openedSession(),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      sessionDetector,
      onAccountsChanged: () => updates.push(1),
      recognitionIntervalMs: 100,
      recognitionMaxAttempts: 2,
    });

    await expect(
      application.openAccount({ accountId: account.id }),
    ).resolves.toEqual({
      sessionId: "session-1",
      profileId: account.profileId,
    });
    expect(openForLogin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);

    expect(sessionDetector).toHaveBeenCalledTimes(2);
    expect(accounts.get(account.id)).toMatchObject({
      status: "authenticated",
      externalAccountId: "douyin-42",
      nickname: "自动识别账号",
      accountInfo: [],
    });
    expect(updates).toHaveLength(1);
  });

  it("recognizes an observed-response login from an event and disposes its listener", async () => {
    const kuaishouAccount: PlatformAccountSnapshot = {
      ...account,
      platformId: "kuaishou",
      profileId: "matrix-kuaishou-account-1",
      displayName: "快手账号",
    };
    const accounts = new Map([[kuaishouAccount.id, kuaishouAccount]]);
    let notifyResponse = () => undefined;
    const dispose = vi.fn();
    const unsubscribe = vi.fn();
    const sessionDetector = vi
      .fn()
      .mockResolvedValueOnce({
        status: "unknown",
        reason: "无法识别当前登录账号",
      })
      .mockResolvedValueOnce({
        status: "authenticated",
        identityScheme: "kuaishou.user_id",
        externalAccountId: "kuaishou-42",
        nickname: "快手账号",
        avatarUrl: null,
        accountInfo: [],
        source: "response",
      });
    const opened = {
      ...openedSession(kuaishouAccount.profileId),
      sessionProbeClient: {
        subscribeObservedResponses(listener: () => void) {
          notifyResponse = listener;
          return unsubscribe;
        },
        dispose,
      },
    } as never;
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => opened,
        openUserPage: async () => opened,
        openForVerification: async () => opened,
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      sessionDetector,
      recognitionIntervalMs: 10,
      recognitionMaxAttempts: 2,
    });

    await application.openAccount({ accountId: kuaishouAccount.id });
    notifyResponse();

    await vi.waitFor(() => {
      expect(accounts.get(kuaishouAccount.id)).toMatchObject({
        status: "authenticated",
        externalAccountId: "kuaishou-42",
      });
    });
    expect(sessionDetector).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("preserves a stable account identity when automatic recognition detects a switched account", async () => {
    const storedAccount: PlatformAccountSnapshot = {
      ...account,
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-1",
      nickname: "原账号",
      displayName: "原账号",
      status: "authenticated",
    };
    const accounts = new Map([[storedAccount.id, storedAccount]]);
    const updates: number[] = [];
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () => openedSession(),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      sessionDetector: async () => ({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-2",
        nickname: "切换后的账号",
        avatarUrl: null,
        accountInfo: [],
        source: "api",
      }),
      onAccountsChanged: () => updates.push(1),
      recognitionMaxAttempts: 1,
    });

    await application.openAccount({ accountId: storedAccount.id });
    await vi.waitFor(() => {
      expect(accounts.get(storedAccount.id)?.status).toBe("unknown");
    });

    expect(accounts.get(storedAccount.id)).toMatchObject({
      externalAccountId: "douyin-1",
      nickname: "原账号",
      displayName: "原账号",
      status: "unknown",
    });
    expect(updates).toHaveLength(1);
  });

  it("requires an explicit refresh to adopt the currently detected account", async () => {
    const storedAccount: PlatformAccountSnapshot = {
      ...account,
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-1",
      nickname: "原账号",
      displayName: "原账号",
      status: "unknown",
    };
    const accounts = new Map([[storedAccount.id, storedAccount]]);
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () => openedSession(),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      sessionDetector: async () => ({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-2",
        nickname: "切换后的账号",
        avatarUrl: null,
        accountInfo: [],
        source: "api",
      }),
    });

    await expect(
      application.verifyAccount({ accountId: storedAccount.id }),
    ).resolves.toEqual({
      status: "unknown",
      reason:
        "当前登录的抖音账号与本地记录不一致，请切回原账号或刷新账号信息后重试",
    });
    expect(accounts.get(storedAccount.id)).toMatchObject({
      externalAccountId: "douyin-1",
      nickname: "原账号",
      displayName: "原账号",
      status: "unknown",
    });

    await expect(
      application.refreshAccount({ accountId: storedAccount.id }),
    ).resolves.toMatchObject({
      status: "authenticated",
      externalAccountId: "douyin-2",
    });
    expect(accounts.get(storedAccount.id)).toMatchObject({
      externalAccountId: "douyin-2",
      nickname: "切换后的账号",
      displayName: "切换后的账号",
      status: "authenticated",
    });
  });

  it("does not downgrade an authenticated account after an inconclusive verification", async () => {
    const storedAccount: PlatformAccountSnapshot = {
      ...account,
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-1",
      nickname: "原账号",
      displayName: "原账号",
      status: "authenticated",
    };
    const accounts = new Map([[storedAccount.id, storedAccount]]);
    const updates: number[] = [];
    const closeVerification = vi.fn(async () => undefined);
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () =>
          ({
            driver: {},
            sessionProbeClient: {},
            close: closeVerification,
          }) as never,
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      sessionDetector: async () => ({
        status: "unknown",
        reason: "无法识别当前登录账号",
      }),
      onAccountsChanged: () => updates.push(1),
    });

    await expect(
      application.verifyAccount({ accountId: storedAccount.id }),
    ).resolves.toEqual({
      status: "unknown",
      reason: "无法识别当前登录账号",
    });
    expect(accounts.get(storedAccount.id)?.status).toBe("authenticated");
    expect(updates).toEqual([]);
    expect(closeVerification).toHaveBeenCalledOnce();
  });

  it("keeps the existing account id and adopts a duplicate candidate profile", async () => {
    const store = new AccountStateRepository(accountPersistence());
    const survivingAccount: PlatformAccountSnapshot = {
      ...account,
      id: "surviving-account",
      profileId: "old-profile",
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-42",
      nickname: "旧账号",
      displayName: "旧账号",
      status: "authenticated",
    };
    store.put(survivingAccount);
    const closeAutomation = vi.fn(async () => undefined);
    const removeProfile = vi.fn(async () => undefined);
    const updates: number[] = [];
    let now = new Date("2026-08-26T00:00:00.000Z");
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: store,
      browserSessions: {
        openForLogin: async (stored) => openedSession(stored.profileId),
        openUserPage: async (stored) => openedSession(stored.profileId),
        openForVerification: async (stored) => openedSession(stored.profileId),
        closeAutomation,
        removeProfile,
      },
      removeAccountResources: async () => undefined,
      createId: () => "candidate-account",
      now: () => now,
      sessionDetector: async () => ({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-42",
        nickname: "最新账号",
        avatarUrl: null,
        accountInfo: [{ key: "follower_count", value: 42 }],
        source: "api",
      }),
      onAccountsChanged: () => updates.push(1),
    });
    const candidate = application.createAccount({ platformId: "douyin" });

    await expect(
      application.refreshAccount({ accountId: candidate.id }),
    ).resolves.toMatchObject({
      status: "authenticated",
      externalAccountId: "douyin-42",
    });

    expect(application.listAccounts()).toEqual([
      expect.objectContaining({
        id: survivingAccount.id,
        profileId: candidate.profileId,
        displayName: "最新账号",
      }),
    ]);
    expect(
      application.resolveAccount({ accountId: candidate.id }),
    ).toMatchObject({
      account: { id: survivingAccount.id, profileId: candidate.profileId },
      replacementAlias: {
        candidateAccountId: candidate.id,
        survivingAccountId: survivingAccount.id,
      },
    });
    expect(
      closeAutomation.mock.calls.map(([stored]) => stored.profileId),
    ).toEqual([survivingAccount.profileId, candidate.profileId]);
    expect(store.listRetiredProfiles()).toEqual([
      expect.objectContaining({ profileId: survivingAccount.profileId }),
    ]);
    expect(updates).toHaveLength(2);

    now = new Date("2026-08-27T00:00:00.001Z");
    await application.cleanupRetiredProfiles();
    expect(removeProfile).toHaveBeenCalledWith(survivingAccount.profileId);
    expect(store.listRetiredProfiles()).toEqual([]);
  });

  it("does not replace the profile while the existing account is publishing", async () => {
    const store = new AccountStateRepository(accountPersistence());
    store.put({
      ...account,
      id: "surviving-account",
      profileId: "old-profile",
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-42",
      status: "authenticated",
    });
    const closeAutomation = vi.fn(async () => undefined);
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: store,
      browserSessions: {
        openForLogin: async (stored) => openedSession(stored.profileId),
        openUserPage: async (stored) => openedSession(stored.profileId),
        openForVerification: async (stored) => openedSession(stored.profileId),
        closeAutomation,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      isAccountBusy: () => true,
      createId: () => "candidate-account",
      sessionDetector: async () => ({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-42",
        nickname: "最新账号",
        avatarUrl: null,
        accountInfo: [],
        source: "api",
      }),
    });
    const candidate = application.createAccount({ platformId: "douyin" });

    await expect(
      application.refreshAccount({ accountId: candidate.id }),
    ).resolves.toEqual({
      status: "unknown",
      reason: "已有账号正在执行发布，将在任务结束后继续更新登录环境",
    });
    expect(application.listAccounts()).toHaveLength(2);
    expect(closeAutomation).not.toHaveBeenCalled();
  });

  it("refreshes optional account profile data after exact identity verification", async () => {
    const storedAccount: PlatformAccountSnapshot = {
      ...account,
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-42",
      nickname: "账号",
      displayName: "账号",
      status: "authenticated",
      accountInfo: [{ key: "following_count", value: 4 }],
    };
    const accounts = new Map([[storedAccount.id, storedAccount]]);
    const close = vi.fn(async () => undefined);
    let resolveProfileResponse!: (response: {
      status: number;
      ok: boolean;
      body: unknown;
    }) => void;
    const profileResponse = new Promise<{
      status: number;
      ok: boolean;
      body: unknown;
    }>((resolve) => {
      resolveProfileResponse = resolve;
    });
    const requestJson = vi.fn(async () => profileResponse);
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () => ({
          ...openedSession(),
          close,
          dataClient: {
            navigate: async () => undefined,
            requestJson,
            waitForJsonResponse: async () => null,
            dispose: () => undefined,
          },
        }),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      sessionDetector: async () => ({
        status: "authenticated",
        identityScheme: "douyin.short_id",
        externalAccountId: "douyin-42",
        nickname: "账号",
        avatarUrl: null,
        source: "api",
      }),
    });

    const refresh = application.refreshAccountProfile({
      accountId: storedAccount.id,
    });
    await vi.waitFor(() => expect(requestJson).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    resolveProfileResponse({
      status: 200,
      ok: true,
      body: {
        user: {
          signature: "新简介",
          follower_count: 25,
          aweme_count: 7,
        },
      },
    });

    await expect(refresh).resolves.toMatchObject({
      accountInfo: [
        { key: "following_count", value: 4 },
        { key: "desc", value: "新简介" },
        { key: "follower_count", value: 25 },
        { key: "content_count", value: 7 },
      ],
      profileSyncedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("records a logged-out detection before rejecting profile refresh", async () => {
    const storedAccount: PlatformAccountSnapshot = {
      ...account,
      lifecycle: "active",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-42",
      nickname: "账号",
      displayName: "账号",
      status: "authenticated",
    };
    const accounts = new Map([[storedAccount.id, storedAccount]]);
    const close = vi.fn(async () => undefined);
    const onAccountsChanged = vi.fn();
    const application = new AccountService({
      platforms: desktopPlatformRegistry,
      ...accountServiceDefaults,
      accountStore: memoryAccountStore(accounts),
      browserSessions: {
        openForLogin: async () => openedSession(),
        openUserPage: async () => openedSession(),
        openForVerification: async () => ({
          ...openedSession(),
          close,
          dataClient: {
            navigate: async () => undefined,
            requestJson: async () => ({
              status: 500,
              ok: false,
              body: null,
            }),
            waitForJsonResponse: async () => null,
            dispose: () => undefined,
          },
        }),
        closeAutomation: async () => undefined,
        removeProfile: async () => undefined,
      },
      removeAccountResources: async () => undefined,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      sessionDetector: async () => ({
        status: "login_required",
        source: "api",
      }),
      onAccountsChanged,
    });

    await expect(
      application.refreshAccountProfile({ accountId: storedAccount.id }),
    ).rejects.toThrow("平台账号未登录");

    expect(accounts.get(storedAccount.id)).toMatchObject({
      status: "login_required",
      lastVerifiedAt: "2026-08-11T00:00:00.000Z",
      identityScheme: "douyin.short_id",
      externalAccountId: "douyin-42",
    });
    expect(onAccountsChanged).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

function accountPersistence() {
  const values = new Map<string, unknown>();
  return {
    get: (key: "state" | "accounts") => values.get(key),
    set: (key: "state", value: unknown) => void values.set(key, value),
  };
}

function memoryAccountStore(accounts: Map<string, PlatformAccountSnapshot>) {
  const requireAccount = (accountId: string) => {
    const stored = accounts.get(accountId);
    if (!stored) throw new TypeError("Platform account does not exist");
    return stored;
  };
  return {
    list: () => [...accounts.values()],
    get: (accountId: string) => accounts.get(accountId),
    require: requireAccount,
    resolve: (accountId: string) => ({ account: requireAccount(accountId) }),
    findActiveByIdentity: (identity: {
      platformId: string;
      identityScheme: string;
      externalAccountId: string;
    }) =>
      [...accounts.values()].filter(
        (candidate) =>
          candidate.lifecycle === "active" &&
          candidate.platformId === identity.platformId &&
          candidate.identityScheme === identity.identityScheme &&
          candidate.externalAccountId === identity.externalAccountId,
      ),
    put: (stored: PlatformAccountSnapshot) =>
      void accounts.set(stored.id, stored),
    replaceCandidateProfile: () => {
      throw new Error("not used");
    },
    listRetiredProfiles: () => [],
    discardRetiredProfile: () => undefined,
    pruneExpiredAliases: () => undefined,
    hasProfileReference: () => false,
  };
}

function openedSession(profileId = account.profileId) {
  return {
    close: async () => undefined,
    id: "session-1",
    profileId,
    page: { isClosed: () => false },
    driver: {},
    sessionProbeClient: {},
  } as never;
}
