import { describe, expect, it, vi } from "vitest";

import type { PlatformModule } from "@nedia-matrix/platform-sdk";
import {
  PlatformContent,
  PlatformContentService,
  type PlatformContentRepository,
  type PlatformContentSnapshot,
  type PlatformContentSyncRun,
} from "../src/index.js";

const firstObservedAt = "2026-09-14T08:00:00.000Z";
const secondObservedAt = "2026-09-14T09:00:00.000Z";

describe("PlatformContent", () => {
  it("merges a new observation without turning missing metrics into zero", () => {
    const content = PlatformContent.create({
      id: "local-1",
      accountId: "account-1",
      platformId: "douyin",
      observedAt: firstObservedAt,
      data: {
        externalContentId: "remote-1",
        contentUrl: "https://www.douyin.com/video/remote-1",
        contentType: "video",
        title: "标题",
        metrics: { viewCount: 10 },
      },
    });

    content.observe(
      {
        externalContentId: "remote-1",
        contentType: "video",
        metrics: { likeCount: 2 },
      },
      secondObservedAt,
    );

    expect(content.toSnapshot()).toMatchObject({
      title: "标题",
      contentUrl: "https://www.douyin.com/video/remote-1",
      metrics: { viewCount: 10, likeCount: 2 },
      metricsObservedAt: secondObservedAt,
    });
  });
});

describe("PlatformContentService", () => {
  it("verifies identity and saves an explicit completed sync", async () => {
    const repository = memoryRepository();
    const updateContentCount = vi.fn();
    const close = vi.fn(async () => undefined);
    const report = vi.fn();
    const finish = vi.fn();
    const start = vi.fn(() => ({
      traceId: "trace-1",
      bind: vi.fn(),
      report,
      finish,
    }));
    const service = new PlatformContentService({
      accounts: {
        require: () => account,
        updateContentCount,
      },
      platforms: {
        require: () =>
          ({
            browser: { allowedHostSuffixes: ["douyin.com"] },
            content: {
              implementationStatus: "reference-derived",
              read: async () => ({
                items: [
                  {
                    externalContentId: "content-remote-1",
                    contentUrl: "https://www.douyin.com/video/content-remote-1",
                    contentType: "video",
                    metrics: { viewCount: 12 },
                  },
                ],
                complete: true,
                pagesRead: 1,
                remoteTotal: 1,
              }),
            },
          }) as unknown as PlatformModule,
      },
      browser: {
        open: async () => ({
          dataClient: dataClientStub,
          verify: async () => ({
            status: "authenticated",
            identityScheme: "douyin.short_id",
            externalAccountId: "account-remote-1",
          }),
          close,
        }),
      },
      repository,
      createId: idSequence("run-1", "content-local-1"),
      now: dateSequence(firstObservedAt, secondObservedAt),
      automationDiagnostics: { start },
    });

    await expect(service.refresh(account.id)).resolves.toMatchObject({
      status: "completed",
      itemsRead: 1,
      remoteTotal: 1,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(updateContentCount).toHaveBeenCalledWith(
      "account-1",
      1,
      secondObservedAt,
    );
    expect(start).toHaveBeenCalledWith({
      operation: "content.sync",
      accountId: "account-1",
      platformId: "douyin",
      requestId: "run-1",
    });
    expect(report.mock.calls.map(([event]) => event.event)).toEqual([
      "content.sync.started",
      "session.detection.started",
      "session.detection.completed",
      "content.reader.started",
      "content.reader.completed",
      "content.sync.persisted",
    ]);
    expect(finish).toHaveBeenCalledWith({ outcome: "completed" });
    expect(service.list(account.id)).toMatchObject([
      {
        externalContentId: "content-remote-1",
        metrics: { viewCount: 12 },
      },
    ]);
    expect(service.contentUrl(account.id, "content-remote-1")).toBe(
      "https://www.douyin.com/video/content-remote-1",
    );
    expect(
      service.findMany(account.id, ["missing", "content-remote-1"]),
    ).toMatchObject([
      {
        externalContentId: "content-remote-1",
        metrics: { viewCount: 12 },
      },
    ]);
  });

  it("records a failed run and closes the sync page when identity changed", async () => {
    const repository = memoryRepository();
    const open = vi.fn();
    const close = vi.fn(async () => undefined);
    const service = new PlatformContentService({
      accounts: {
        require: () => account,
        updateContentCount: vi.fn(),
      },
      platforms: { require: () => ({ content: {} }) as PlatformModule },
      browser: {
        open: async () => {
          open();
          return {
            dataClient: dataClientStub,
            verify: async () => ({
              status: "authenticated",
              identityScheme: "douyin.short_id",
              externalAccountId: "another-account",
            }),
            close,
          };
        },
      },
      repository,
      createId: () => "run-1",
      now: dateSequence(firstObservedAt, secondObservedAt),
      automationDiagnostics: {
        start: () => {
          throw new Error("diagnostics unavailable");
        },
      },
    });

    await expect(service.refresh(account.id)).resolves.toMatchObject({
      status: "failed",
      diagnostics: ["当前登录的平台账号与本地记录不一致"],
    });
    expect(open).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(repository.latestRun(account.id)?.status).toBe("failed");
  });
});

const account = {
  id: "account-1",
  platformId: "douyin",
  lifecycle: "active" as const,
  status: "authenticated" as const,
  identityScheme: "douyin.short_id",
  externalAccountId: "account-remote-1",
};

const dataClientStub = {
  navigate: async () => undefined,
  requestJson: async () => ({ status: 200, ok: true, body: {} }),
  waitForJsonResponse: async () => null,
  scrollToEnd: async () => ({ found: true, moved: true, atEnd: true }),
  dispose: () => undefined,
};

function memoryRepository(): PlatformContentRepository {
  const contents = new Map<string, PlatformContentSnapshot>();
  const runs = new Map<string, PlatformContentSyncRun>();
  return {
    listByAccount: (accountId) =>
      [...contents.values()].filter((item) => item.accountId === accountId),
    findMany: (accountId, externalContentIds) =>
      [...contents.values()].filter(
        (item) =>
          item.accountId === accountId &&
          externalContentIds.includes(item.externalContentId),
      ),
    find: (accountId, externalContentId) =>
      [...contents.values()].find(
        (item) =>
          item.accountId === accountId &&
          item.externalContentId === externalContentId,
      ),
    saveAll: (items, run) => {
      for (const item of items) contents.set(item.id, item);
      runs.set(run.accountId, run);
    },
    saveRun: (run) => runs.set(run.accountId, run),
    latestRun: (accountId) => runs.get(accountId),
  };
}

function idSequence(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function dateSequence(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[index++] ?? values.at(-1) ?? firstObservedAt);
}
