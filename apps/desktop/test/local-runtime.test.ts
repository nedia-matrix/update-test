import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import type { PublicationSummary } from "@nedia-matrix/publishing";
import type {
  PlatformContentSnapshot,
  PlatformContentSyncRun,
} from "@nedia-matrix/platform-content";

import {
  LocalRuntimeHttpServer,
  type LocalRuntimeHandshake,
} from "../src/main/runtime-api/http/local-runtime-http-server.js";
import {
  AccountReplacedError,
  PlatformAccountIdentityError,
} from "@nedia-matrix/account-management";

const origin = "https://www.example.com";

function requestStatus(options: {
  headers: Record<string, string>;
  port: number;
}): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: options.headers,
        host: "127.0.0.1",
        path: "/v1/runtime",
        port: options.port,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const handshake: LocalRuntimeHandshake = {
  protocolVersion: 1,
  runtimeKind: "desktop_playwright",
  runtimeVersion: "0.0.0",
  instanceId: "runtime-instance",
  supportedTargets: [
    { platform: "douyin", contentForm: "video" },
    { platform: "xiaohongshu", contentForm: "image_text" },
  ],
  capabilities: {
    isolatedAccounts: true,
    multipleAccountsPerPlatform: true,
    backgroundObservation: true,
    localPublicationArchive: true,
    platformIdentityAddressing: true,
    platformContentSnapshots: true,
    platformContentSync: true,
  },
};

const account: PlatformAccountSnapshot = {
  id: "account-1",
  platformId: "douyin",
  profileId: "matrix-douyin-account-1",
  lifecycle: "active",
  displayName: "抖音账号",
  identityScheme: "douyin.short_id",
  externalAccountId: "external-1",
  nickname: "测试账号",
  avatarUrl: "https://example.com/avatar.png",
  accountInfo: [
    { key: "follower_count", value: 12800 },
    { key: "following_count", value: 128 },
  ],
  profileSyncedAt: null,
  status: "authenticated",
  lastVerifiedAt: "2026-08-10T00:00:00.000Z",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

function createRuntimeApplication(
  initialAccounts: PlatformAccountSnapshot[] = [account],
  options?: {
    deletedRequestId?: string;
    publicationBusy?: boolean;
    publicationFailure?: { message: string };
    verificationMismatch?: boolean;
    replacementAlias?: {
      candidateAccountId: string;
      survivingAccountId: string;
    };
  },
) {
  const accounts = initialAccounts.map((stored) => ({
    ...stored,
    accountInfo: [...(stored.accountInfo ?? [])],
  }));
  const actions: string[] = [];
  const publications: PublicationSummary[] = [];
  const platformContents: PlatformContentSnapshot[] = [
    {
      id: "local-content-1",
      accountId: account.id,
      platformId: account.platformId,
      externalContentId: "content-1",
      contentUrl: "https://www.douyin.com/video/content-1",
      contentType: "video",
      title: "已有作品",
      description: null,
      coverUrl: null,
      publishedAt: "2026-08-09T00:00:00.000Z",
      platformStatus: "published",
      metrics: { viewCount: 12, likeCount: 0 },
      contentObservedAt: "2026-08-10T00:00:00.000Z",
      metricsObservedAt: "2026-08-10T00:00:00.000Z",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  ];
  const latestContentRun = (accountId: string): PlatformContentSyncRun => ({
    id: "content-run-1",
    accountId,
    status: "partial",
    startedAt: "2026-08-10T00:00:00.000Z",
    completedAt: "2026-08-10T00:00:01.000Z",
    pagesRead: 1,
    itemsRead: 1,
    remoteTotal: 2,
    diagnostics: ["more pages were available"],
  });
  const resolveAccount = (accountId: string) => {
    const replacementAlias =
      options?.replacementAlias?.candidateAccountId === accountId
        ? {
            ...options.replacementAlias,
            createdAt: "2026-08-10T00:00:00.000Z",
            expiresAt: "2026-08-11T00:00:00.000Z",
          }
        : undefined;
    const resolvedAccountId = replacementAlias?.survivingAccountId ?? accountId;
    const resolved = accounts.find(
      (candidate) => candidate.id === resolvedAccountId,
    );
    if (!resolved) throw new TypeError("Runtime account does not exist");
    return {
      account: resolved,
      ...(replacementAlias ? { replacementAlias } : {}),
    };
  };
  const resolveExternalIdentity = (
    platformId: string,
    externalAccountId: string,
  ) => {
    const matches = accounts.filter(
      (candidate) =>
        candidate.lifecycle === "active" &&
        candidate.platformId === platformId &&
        candidate.externalAccountId === externalAccountId,
    );
    if (matches.length === 0)
      throw new PlatformAccountIdentityError(
        "ACCOUNT_NOT_FOUND",
        "No local account matches the platform identity",
      );
    if (matches.length > 1)
      throw new PlatformAccountIdentityError(
        "ACCOUNT_AMBIGUOUS",
        "Multiple local accounts match the platform identity",
      );
    return matches[0]!;
  };
  const legacyApplication = {
    listPlatforms: () => [
      {
        id: "douyin",
        displayName: "抖音",
        entryUrl: "https://creator.douyin.com/",
        rulesVersion: "1",
        implementationStatus: "live-tested" as const,
        loginEntries: [
          {
            id: "creator",
            displayName: "创作者中心",
            url: "https://creator.douyin.com/",
          },
        ],
        publishCapabilities: [],
      },
    ],
    listAccounts: () => [...accounts],
    listPublications: () => [...publications],
    prepareRemoteDraft: async (request: {
      accountId: string;
      requestId: string;
      contentForm: "video" | "imageText";
      title: string;
      body: string;
    }) => {
      actions.push(`publish:${request.requestId}`);
      if (options?.publicationBusy) {
        return { status: "account_busy" as const };
      }
      if (options?.publicationFailure) {
        return {
          status: "failed" as const,
          code: "UNEXPECTED_ERROR",
          message: options.publicationFailure.message,
          evidenceId: null,
        };
      }
      publications.push({
        id: "publication-1",
        requestId: request.requestId,
        platformId: "douyin",
        accountId: request.accountId,
        contentForm: request.contentForm,
        title: request.title,
        body: request.body,
        assets: [{ name: "video.mp4", size: 42 }],
        state: "awaiting_confirmation",
        transitions: [],
        rulesVersion: "test",
        retained: false,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        lastMessage: "请前往平台窗口检查并发布",
        platformContentId: null,
        platformContentUrl: null,
      });
      return {
        status: "ready_for_review" as const,
        mediaCount: 1,
        profileId: "profile-1",
        publishObservationId: "observation-1",
        publicationId: "publication-1",
      };
    },
    createAccount: ({ platformId }: { platformId: string }) => {
      if (platformId !== "douyin") throw new TypeError("Unknown platform");
      const created: PlatformAccountSnapshot = {
        ...account,
        id: `account-${accounts.length + 1}`,
        lifecycle: "pending_identity",
        identityScheme: null,
        externalAccountId: null,
        nickname: null,
        status: "login_required",
      };
      accounts.push(created);
      actions.push(`create:${platformId}`);
      return created;
    },
    openLogin: async ({ accountId }: { accountId: string }) => {
      actions.push(`login:${accountId}`);
      return { profileId: `profile:${accountId}` };
    },
    openAccount: async ({ accountId }: { accountId: string }) => {
      actions.push(`open:${accountId}`);
      return {
        profileId: `profile:${accountId}`,
        sessionId: `session:${accountId}`,
      };
    },
    refreshAccount: async ({ accountId }: { accountId: string }) => {
      actions.push(`refresh:${accountId}`);
      const stored = resolveAccount(accountId).account;
      stored.status = "authenticated";
      stored.externalAccountId = "refreshed-external";
      stored.nickname = "刷新后的账号";
      stored.accountInfo = [{ key: "follower_count", value: 25600 }];
      return {
        status: "authenticated" as const,
        identityScheme: "douyin.short_id",
        externalAccountId: stored.externalAccountId,
        nickname: stored.nickname,
        avatarUrl: null,
        accountInfo: [{ key: "follower_count", value: 25600 }],
        source: "api" as const,
      };
    },
    verifyAccount: async ({ accountId }: { accountId: string }) => {
      actions.push(`verify:${accountId}`);
      const stored = accounts.find((candidate) => candidate.id === accountId);
      if (!stored) throw new TypeError("Platform account does not exist");
      if (options?.verificationMismatch) {
        stored.status = "unknown";
        return {
          status: "unknown" as const,
          reason: "Runtime account identity changed",
        };
      }
      stored.status = "authenticated";
      return {
        status: "authenticated" as const,
        identityScheme: "douyin.short_id",
        externalAccountId: stored.externalAccountId!,
        nickname: stored.nickname!,
        avatarUrl: stored.avatarUrl,
        accountInfo: stored.accountInfo ?? [],
        source: "api" as const,
      };
    },
    removeAccount: async ({ accountId }: { accountId: string }) => {
      actions.push(`remove:${accountId}`);
      const resolved = resolveAccount(accountId);
      if (resolved.replacementAlias) {
        throw new AccountReplacedError(resolved.account.id);
      }
      const index = accounts.findIndex(
        (candidate) => candidate.id === accountId,
      );
      if (index === -1) throw new TypeError("Platform account does not exist");
      accounts.splice(index, 1);
    },
  };
  return {
    accounts,
    actions,
    publications,
    application: {
      platforms: {
        get: () => undefined,
        require: () => {
          throw new TypeError("not used");
        },
        list: () => [],
      },
      platformSummaries: legacyApplication.listPlatforms,
      accounts: {
        list: legacyApplication.listAccounts,
        resolve: ({ accountId }: { accountId: string }) =>
          resolveAccount(accountId),
        resolveByExternalIdentity: ({
          platformId,
          externalAccountId,
        }: {
          platformId: string;
          externalAccountId: string;
        }) => {
          return resolveExternalIdentity(platformId, externalAccountId);
        },
        verifyByExternalIdentity: async ({
          platformId,
          externalAccountId,
        }: {
          platformId: string;
          externalAccountId: string;
        }) => {
          const matches = accounts.filter(
            (candidate) =>
              candidate.lifecycle === "active" &&
              candidate.platformId === platformId &&
              candidate.externalAccountId === externalAccountId,
          );
          if (matches.length === 0)
            throw new PlatformAccountIdentityError(
              "ACCOUNT_NOT_FOUND",
              "No local account matches the platform identity",
            );
          if (matches.length > 1)
            throw new PlatformAccountIdentityError(
              "ACCOUNT_AMBIGUOUS",
              "Multiple local accounts match the platform identity",
            );
          const resolved = matches[0]!;
          const detected = await legacyApplication.verifyAccount({
            accountId: resolved.id,
          });
          if (detected.status === "login_required")
            throw Object.assign(
              new Error("Runtime account is not authenticated"),
              {
                code: "NOT_LOGGED_IN",
              },
            );
          if (
            detected.status !== "authenticated" ||
            detected.externalAccountId !== externalAccountId
          )
            throw Object.assign(
              new Error("Runtime account identity does not match"),
              {
                code: "ACCOUNT_IDENTITY_MISMATCH",
              },
            );
          return resolved;
        },
        create: legacyApplication.createAccount,
        openLogin: legacyApplication.openLogin,
        open: legacyApplication.openAccount,
        refresh: legacyApplication.refreshAccount,
        verify: legacyApplication.verifyAccount,
        remove: legacyApplication.removeAccount,
        cleanupRetiredProfiles: async () => undefined,
      },
      publications: {
        list: legacyApplication.listPublications,
        wasDeleted: (requestId: string) =>
          requestId === options?.deletedRequestId,
        publicationUrl: () => {
          throw new Error("not used");
        },
        prepareRemote: legacyApplication.prepareRemoteDraft,
        prepare: () => {
          throw new Error("not used");
        },
      },
      platformContents: {
        list: (accountId: string) =>
          platformContents.filter((content) => content.accountId === accountId),
        queryByExternalIdentity: ({
          platformId,
          externalAccountId,
          externalContentIds,
        }: {
          platformId: string;
          externalAccountId: string;
          externalContentIds: readonly string[];
        }) => {
          const resolved = resolveExternalIdentity(
            platformId,
            externalAccountId,
          );
          return {
            contents: platformContents.filter(
              (content) =>
                content.accountId === resolved.id &&
                externalContentIds.includes(content.externalContentId),
            ),
            latestRun: latestContentRun(resolved.id),
          };
        },
        latestRun: (accountId: string) => latestContentRun(accountId),
        contentUrl: () => {
          throw new Error("not used");
        },
        refresh: async (accountId: string) => latestContentRun(accountId),
        refreshByExternalIdentity: async ({
          platformId,
          externalAccountId,
        }: {
          platformId: string;
          externalAccountId: string;
        }) => {
          const resolved = resolveExternalIdentity(
            platformId,
            externalAccountId,
          );
          actions.push(`content-sync:${resolved.id}`);
          return latestContentRun(resolved.id);
        },
      },
    },
    platformContents,
  };
}

describe("LocalRuntimeHttpServer", () => {
  const servers: LocalRuntimeHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it("reports whether the local runtime is listening", async () => {
    const runtime = createRuntimeApplication([]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    expect(server.status()).toEqual({
      status: "stopped",
      version: handshake.runtimeVersion,
      host: "127.0.0.1",
      port: null,
    });

    const port = await server.start();
    expect(server.status()).toEqual({
      status: "running",
      version: handshake.runtimeVersion,
      host: "127.0.0.1",
      port,
    });

    await server.stop();
    expect(server.status()).toMatchObject({ status: "stopped", port: null });

    const restartedPort = await server.start();
    expect(server.status()).toMatchObject({
      status: "running",
      port: restartedPort,
    });
  });

  it("records failures without logging every successful runtime request", async () => {
    const runtime = createRuntimeApplication([]);
    const events: string[] = [];
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
      diagnostics: {
        start: () => ({
          traceId: "trace-1",
          bind: () => undefined,
          report: ({ event }) => events.push(event),
          finish: ({ outcome }) => events.push(`finish:${outcome}`),
        }),
      },
    });
    servers.push(server);
    const port = await server.start();

    const response = await fetch(`http://127.0.0.1:${port}/v1/runtime`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(events).toEqual([]);

    const missing = await fetch(`http://127.0.0.1:${port}/v1/missing`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    expect(events).toEqual(["runtime.request.completed", "finish:rejected"]);
  });

  it("stops without waiting for an active request to finish", async () => {
    const runtime = createRuntimeApplication([]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const request = httpRequest({
      headers: { "Content-Type": "application/json" },
      host: "127.0.0.1",
      method: "POST",
      path: "/v1/publications",
      port,
    });
    const connected = new Promise<void>((resolve) => {
      request.on("socket", (socket) => {
        if (socket.connecting) socket.once("connect", resolve);
        else resolve();
      });
    });
    const requestClosed = new Promise<void>((resolve) => {
      request.on("error", () => resolve());
      request.on("close", () => resolve());
    });
    request.write("{");
    await connected;

    await server.stop();

    await requestClosed;
    expect(server.status()).toMatchObject({ status: "stopped", port: null });
  });

  it("discovers the runtime and exposes accounts without authorization", async () => {
    const runtime = createRuntimeApplication();
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    const discovery = await fetch(`${baseUrl}/v1/runtime`, {
      headers: { Origin: origin },
    });
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("access-control-allow-origin")).toBe("*");
    expect(await discovery.json()).toEqual(handshake);

    const preflight = await fetch(`${baseUrl}/v1/accounts`, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Private-Network": "true",
        Origin: origin,
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );

    const accounts = await fetch(`${baseUrl}/v1/accounts`);
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toEqual([
      {
        runtimeAccountId: "account-1",
        platform: "douyin",
        loggedIn: true,
        status: "connected",
        nickname: "测试账号",
        externalAccountId: "external-1",
        avatarUrl: "https://example.com/avatar.png",
        accountInfo: [
          { key: "follower_count", value: 12800 },
          { key: "following_count", value: 128 },
        ],
        lastVerifiedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
  });

  it("queries cached platform content by stable external identity", async () => {
    const runtime = createRuntimeApplication([
      { ...account, status: "login_required" },
    ]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/platform-content-snapshots/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: {
            platform: "douyin",
            externalAccountId: "external-1",
          },
          externalContentIds: ["content-1", "missing", "content-1"],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      target: {
        platform: "douyin",
        externalAccountId: "external-1",
      },
      latestSync: {
        status: "partial",
        startedAt: "2026-08-10T00:00:00.000Z",
        completedAt: "2026-08-10T00:00:01.000Z",
        pagesRead: 1,
        itemsRead: 1,
        remoteTotal: 2,
      },
      results: [
        {
          externalContentId: "content-1",
          status: "found",
          snapshot: {
            contentUrl: "https://www.douyin.com/video/content-1",
            contentType: "video",
            title: "已有作品",
            description: null,
            coverUrl: null,
            publishedAt: "2026-08-09T00:00:00.000Z",
            platformStatus: "published",
            metrics: { viewCount: 12, likeCount: 0 },
            contentObservedAt: "2026-08-10T00:00:00.000Z",
            metricsObservedAt: "2026-08-10T00:00:00.000Z",
          },
        },
        {
          externalContentId: "missing",
          status: "not_observed",
          snapshot: null,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("account-1");
    expect(JSON.stringify(body)).not.toContain("content-run-1");
  });

  it("syncs platform content by stable external identity", async () => {
    const runtime = createRuntimeApplication();
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/platform-content-syncs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: {
            platform: "douyin",
            externalAccountId: "external-1",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      target: {
        platform: "douyin",
        externalAccountId: "external-1",
      },
      run: {
        status: "partial",
        pagesRead: 1,
        itemsRead: 1,
        remoteTotal: 2,
        diagnostics: ["more pages were available"],
      },
    });
    expect(runtime.actions).toContain("content-sync:account-1");
    expect(JSON.stringify(body)).not.toContain("account-1");
    expect(JSON.stringify(body)).not.toContain("content-run-1");
  });

  it("rejects local identity fields and reports missing content accounts", async () => {
    const runtime = createRuntimeApplication([]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const query = (body: object) =>
      fetch(`http://127.0.0.1:${port}/v1/platform-content-snapshots/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const internalIdentity = await query({
      target: {
        platform: "douyin",
        externalAccountId: "external-1",
        runtimeAccountId: "account-1",
      },
      externalContentIds: ["content-1"],
    });
    expect(internalIdentity.status).toBe(400);
    expect(await internalIdentity.json()).toMatchObject({
      code: "INVALID_REQUEST",
    });

    const missing = await query({
      target: {
        platform: "douyin",
        externalAccountId: "external-1",
      },
      externalContentIds: ["content-1"],
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("creates, opens, refreshes, and removes an isolated account", async () => {
    const runtime = createRuntimeApplication([]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      "Content-Type": "application/json",
    };

    const createdResponse = await fetch(`${baseUrl}/v1/accounts`, {
      body: JSON.stringify({ platform: "douyin" }),
      headers,
      method: "POST",
    });
    const created = (await createdResponse.json()) as {
      runtimeAccountId: string;
    };
    expect(createdResponse.status).toBe(201);
    expect(created).toMatchObject({ platform: "douyin", status: "expired" });

    const openResponse = await fetch(
      `${baseUrl}/v1/accounts/${created.runtimeAccountId}/open`,
      {
        body: "{}",
        headers,
        method: "POST",
      },
    );
    expect(openResponse.status).toBe(200);
    expect(runtime.actions).toContain(`login:${created.runtimeAccountId}`);

    const refreshResponse = await fetch(
      `${baseUrl}/v1/accounts/${created.runtimeAccountId}/refresh`,
      {
        body: "{}",
        headers,
        method: "POST",
      },
    );
    expect(await refreshResponse.json()).toMatchObject({
      externalAccountId: "refreshed-external",
      status: "connected",
    });

    const removeResponse = await fetch(
      `${baseUrl}/v1/accounts/${created.runtimeAccountId}`,
      {
        headers,
        method: "DELETE",
      },
    );
    expect(removeResponse.status).toBe(200);
    expect(runtime.accounts).toEqual([]);
  });

  it("does not expose the removed account-binding routes", async () => {
    const runtime = createRuntimeApplication();
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/account-bindings`,
    );
    expect(response.status).toBe(404);
  });

  it("resolves a replaced candidate id without adding a new HTTP flow", async () => {
    const runtime = createRuntimeApplication([account], {
      replacementAlias: {
        candidateAccountId: "candidate-account",
        survivingAccountId: account.id,
      },
    });
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { "Content-Type": "application/json" };

    const refreshResponse = await fetch(
      `${baseUrl}/v1/accounts/candidate-account/refresh`,
      { body: "{}", headers, method: "POST" },
    );
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.json()).toMatchObject({
      runtimeAccountId: account.id,
      resolution: {
        kind: "existing_account_profile_replaced",
        requestedRuntimeAccountId: "candidate-account",
      },
    });

    const removeResponse = await fetch(
      `${baseUrl}/v1/accounts/candidate-account`,
      { headers, method: "DELETE" },
    );
    expect(removeResponse.status).toBe(409);
    expect(await removeResponse.json()).toMatchObject({
      code: "ACCOUNT_REPLACED",
      runtimeAccountId: account.id,
    });
    expect(runtime.accounts).toEqual([
      expect.objectContaining({ id: account.id }),
    ]);
  });

  it("reports missing and ambiguous platform identities", async () => {
    const runtime = createRuntimeApplication([]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const request = {
      requestId: "identity-selection",
      target: {
        platform: "douyin",
        contentForm: "video",
        externalAccountId: "external-1",
      },
      content: {
        title: "身份选择",
        video: {
          url: "https://assets.example.test/video.mp4",
          name: "video.mp4",
          type: "video/mp4",
        },
      },
    };
    const publish = () =>
      fetch(`http://127.0.0.1:${port}/v1/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

    const missing = await publish();
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });

    runtime.accounts.push(account, { ...account, id: "account-2" });
    const ambiguous = await publish();
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "ACCOUNT_AMBIGUOUS" });
    expect(runtime.publications).toEqual([]);
  });

  it("publishes through different local account ids for the same platform identity", async () => {
    const firstRuntime = createRuntimeApplication([account]);
    const secondRuntime = createRuntimeApplication([
      { ...account, id: "account-on-second-desktop" },
    ]);
    const firstServer = new LocalRuntimeHttpServer({
      application: firstRuntime.application,
      handshake,
      port: 0,
    });
    const secondServer = new LocalRuntimeHttpServer({
      application: secondRuntime.application,
      handshake: { ...handshake, instanceId: "second-runtime" },
      port: 0,
    });
    servers.push(firstServer, secondServer);
    const [firstPort, secondPort] = await Promise.all([
      firstServer.start(),
      secondServer.start(),
    ]);
    const request = {
      requestId: "cross-desktop",
      target: {
        platform: "douyin",
        contentForm: "video",
        externalAccountId: "external-1",
      },
      content: {
        title: "跨电脑发布",
        video: {
          url: "https://assets.example.test/video.mp4",
          name: "video.mp4",
          type: "video/mp4",
        },
      },
    };
    const publish = (port: number) =>
      fetch(`http://127.0.0.1:${port}/v1/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

    const [first, second] = await Promise.all([
      publish(firstPort),
      publish(secondPort),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(firstRuntime.publications[0]?.accountId).toBe("account-1");
    expect(secondRuntime.publications[0]?.accountId).toBe(
      "account-on-second-desktop",
    );
  });

  it("rejects publication when the verified stable identity changed", async () => {
    const runtime = createRuntimeApplication([account], {
      verificationMismatch: true,
    });
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const publication = await fetch(
      `http://127.0.0.1:${port}/v1/publications`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "identity-mismatch",
          target: {
            platform: "douyin",
            contentForm: "video",
            externalAccountId: "external-1",
          },
          content: {
            title: "不会发布",
            body: { type: "plain_text", text: "正文" },
            video: {
              url: "https://assets.example.test/video.mp4",
              name: "video.mp4",
              type: "video/mp4",
            },
          },
          limits: {},
        }),
      },
    );
    expect(publication.status).toBe(409);
    expect(await publication.json()).toMatchObject({
      code: "ACCOUNT_IDENTITY_MISMATCH",
    });
    expect(runtime.actions).not.toContain("publish:identity-mismatch");
  });

  it("creates a publication by external identity once and restores its final status by request id", async () => {
    const runtime = createRuntimeApplication();
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      "Content-Type": "application/json",
    };

    const publicationRequest = {
      requestId: "request-1",
      target: {
        platform: "douyin",
        contentForm: "video",
        externalAccountId: "external-1",
      },
      content: {
        title: "测试视频",
        body: { type: "plain_text", text: "正文" },
        video: {
          url: "https://assets.example.test/video.mp4",
          name: "video.mp4",
          type: "video/mp4",
        },
      },
      limits: {},
    };
    const created = await fetch(`${baseUrl}/v1/publications`, {
      method: "POST",
      headers,
      body: JSON.stringify(publicationRequest),
    });
    expect(created.status).toBe(202);
    expect(await created.json()).toMatchObject({
      requestId: "request-1",
      state: "awaiting_confirmation",
    });
    expect(
      runtime.actions.filter((action) => action.startsWith("publish:")),
    ).toEqual(["publish:request-1"]);

    Object.assign(runtime.publications[0]!, {
      state: "published",
      platformContentId: "work-1",
      platformContentUrl: "https://www.douyin.com/video/work-1",
    });
    server.publishPublicationUpdate("publication-1");
    const status = await fetch(`${baseUrl}/v1/publications/request-1`, {
      headers,
    });
    expect(await status.json()).toMatchObject({
      requestId: "request-1",
      state: "published",
      result: {
        ok: true,
        platformPostId: "work-1",
      },
    });

    runtime.accounts.splice(0);
    const replay = await fetch(`${baseUrl}/v1/publications`, {
      method: "POST",
      headers,
      body: JSON.stringify(publicationRequest),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      requestId: "request-1",
      state: "published",
    });
    expect(
      runtime.actions.filter((action) => action.startsWith("verify:")),
    ).toEqual(["verify:account-1"]);
    expect(
      runtime.actions.filter((action) => action.startsWith("publish:")),
    ).toEqual(["publish:request-1"]);

    const events = await fetch(`${baseUrl}/v1/events?after=0`, { headers });
    expect(await events.json()).toMatchObject({
      cursor: 1,
      reset: false,
      events: [
        {
          type: "runtime.publish.result",
          requestId: "request-1",
          result: { state: "published", platformPostId: "work-1" },
        },
      ],
    });
  });

  it("reports a deleted request and refuses to publish it again", async () => {
    const runtime = createRuntimeApplication([account], {
      deletedRequestId: "deleted-request",
    });
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const status = await fetch(`${baseUrl}/v1/publications/deleted-request`);
    expect(await status.json()).toEqual({
      requestId: "deleted-request",
      state: "deleted",
    });
    const replay = await fetch(`${baseUrl}/v1/publications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "deleted-request",
        target: {
          platform: "douyin",
          contentForm: "video",
          externalAccountId: "external-1",
        },
        content: {
          title: "测试视频",
          body: { type: "plain_text", text: "正文" },
          video: {
            url: "https://assets.example.test/video.mp4",
            name: "video.mp4",
            type: "video/mp4",
          },
        },
        limits: {},
      }),
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "PUBLICATION_DELETED",
    });
    expect(runtime.actions).not.toContain("publish:deleted-request");
  });

  it("reports an account-level publication conflict without creating history", async () => {
    const runtime = createRuntimeApplication([account], {
      publicationBusy: true,
    });
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/publications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "request-busy",
        target: {
          platform: "douyin",
          contentForm: "video",
          externalAccountId: "external-1",
        },
        content: {
          title: "测试视频",
          body: { type: "plain_text", text: "正文" },
          video: {
            url: "https://assets.example.test/video.mp4",
            name: "video.mp4",
            type: "video/mp4",
          },
        },
        limits: {},
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_BUSY" });
    expect(runtime.publications).toEqual([]);
  });

  it("reports the preparation failure when no publication was created", async () => {
    const runtime = createRuntimeApplication([account], {
      publicationFailure: { message: "Invalid publication metadata" },
    });
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/publications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "request-failed",
        target: {
          platform: "douyin",
          contentForm: "video",
          externalAccountId: "external-1",
        },
        content: {
          title: "测试视频",
          body: { type: "plain_text", text: "正文" },
          video: {
            url: "https://assets.example.test/video.mp4",
            name: "video.mp4",
            type: "video/mp4",
          },
        },
        limits: {},
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "PUBLISH_FAILED",
      message: "Invalid publication metadata",
    });
    expect(runtime.publications).toEqual([]);
  });

  it("allows missing origins and rejects forged Host headers", async () => {
    const runtime = createRuntimeApplication([]);
    const server = new LocalRuntimeHttpServer({
      application: runtime.application,
      handshake,
      port: 0,
    });
    servers.push(server);
    const port = await server.start();

    expect((await fetch(`http://127.0.0.1:${port}/v1/runtime`)).status).toBe(
      200,
    );
    expect(
      await requestStatus({
        headers: { Host: `localhost:${port}`, Origin: origin },
        port,
      }),
    ).toBe(400);
  });
});
