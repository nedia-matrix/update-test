import { describe, expect, it, vi } from "vitest";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";

import {
  kuaishouPlatformModule,
  parseKuaishouAccountProfile,
  parseKuaishouAccountSupplement,
  parseKuaishouContentPage,
} from "../src/index.js";

describe("Kuaishou data reader", () => {
  const client = (scrollForJsonResponse: ReturnType<typeof vi.fn>) => ({
    navigate: async () => undefined,
    navigateForJsonResponses: async () => [
      {
        status: 200,
        ok: true,
        body: {
          result: 1,
          data: {
            total: 2,
            nextCursor: "cursor-2",
            list: [{ workId: "content-1", userId: 42 }],
          },
        },
      },
    ],
    requestJson: vi.fn(),
    waitForJsonResponse: async () => null,
    scrollToEnd: async () => ({ found: true, moved: false, atEnd: false }),
    scrollForJsonResponse,
    dispose: () => undefined,
  });
  it.each([
    { code: "rate_limited", reason: "平台请求受限" },
    { code: "scroll_failed", reason: "页面滚动失败" },
  ] as const)(
    "retains verified pages after $code without retrying or exposing request details",
    async ({ code, reason }) => {
      const scroll = vi
        .fn()
        .mockRejectedValue(
          new PlatformDataOperationError(
            code,
            "https://creator.example/api?token=secret",
          ),
        );
      await expect(
        kuaishouPlatformModule.content!.read(client(scroll), "42"),
      ).resolves.toMatchObject({
        complete: false,
        pagesRead: 1,
        remoteTotal: 2,
        items: [{ externalContentId: "content-1" }],
        diagnostics: [expect.stringContaining(reason)],
      });
      expect(scroll).toHaveBeenCalledOnce();
    },
  );
  it("propagates cancellation and later account mismatches", async () => {
    const cancelled = new Error("页面控制权已移交或自动操作已取消");
    await expect(
      kuaishouPlatformModule.content!.read(
        client(vi.fn().mockRejectedValue(cancelled)),
        "42",
      ),
    ).rejects.toBe(cancelled);
    const scroll = vi.fn().mockResolvedValue({
      scroll: { found: true, moved: true, atEnd: false },
      response: {
        status: 200,
        ok: true,
        body: {
          result: 1,
          data: { list: [{ workId: "content-2", userId: 99 }] },
        },
      },
    });
    await expect(
      kuaishouPlatformModule.content!.read(client(scroll), "42"),
    ).rejects.toThrow("账号与当前登录账号不一致");
  });
  it("maps available profile counters and leaves absent values unknown", () => {
    expect(
      parseKuaishouAccountProfile({
        data: {
          coreUserInfo: { userText: "简介", fansNum: 39 },
        },
      }),
    ).toEqual({ description: "简介", followerCount: 39 });
  });

  it("maps infoV2 as an identity-checked profile supplement", () => {
    expect(
      parseKuaishouAccountSupplement(
        {
          result: 1,
          message: "成功",
          data: {
            likeCnt: 115,
            userKwaiId: null,
            userName: "yuyu",
            fansCnt: 39,
            userId: 5638496993,
            followCnt: 2,
            desc: "",
          },
        },
        "5638496993",
      ),
    ).toEqual({ likeCount: 115 });

    expect(
      parseKuaishouAccountSupplement(
        { result: 1, data: { likeCnt: 0, userId: 5638496993 } },
        "5638496993",
      ),
    ).toEqual({ likeCount: 0 });
  });

  it("rejects a supplement belonging to a different account", () => {
    expect(() =>
      parseKuaishouAccountSupplement(
        { result: 1, data: { likeCnt: 115, userId: 42 } },
        "5638496993",
      ),
    ).toThrow("与当前账号不一致");
    expect(() =>
      parseKuaishouAccountSupplement(
        { result: 0, data: { likeCnt: 115, userId: 5638496993 } },
        "5638496993",
      ),
    ).toThrow("资料补全响应失败");
  });

  it("combines userInfo with an optional infoV2 supplement", async () => {
    const waitForJsonResponse = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith("/home/userInfo")) {
        return {
          status: 200,
          ok: true,
          body: {
            data: {
              coreUserInfo: {
                userId: 5638496993,
                userText: "简介",
                fansNum: 39,
              },
            },
          },
        };
      }
      return {
        status: 200,
        ok: true,
        body: {
          result: 1,
          data: { userId: 5638496993, likeCnt: 115 },
        },
      };
    });
    const navigate = vi.fn(async () => undefined);

    await expect(
      kuaishouPlatformModule.accountProfile!.read({
        navigate,
        requestJson: async () => ({ status: 500, ok: false, body: null }),
        waitForJsonResponse,
        scrollToEnd: async () => ({
          found: true,
          moved: true,
          atEnd: true,
        }),
        dispose: () => undefined,
      }),
    ).resolves.toEqual({
      description: "简介",
      followerCount: 39,
      likeCount: 115,
    });
    expect(waitForJsonResponse).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith("https://cp.kuaishou.com/profile");
  });

  it("keeps the primary profile when infoV2 is unavailable", async () => {
    await expect(
      kuaishouPlatformModule.accountProfile!.read({
        navigate: async () => undefined,
        requestJson: async () => ({ status: 500, ok: false, body: null }),
        waitForJsonResponse: async ({ url }) =>
          url.endsWith("/home/userInfo")
            ? {
                status: 200,
                ok: true,
                body: {
                  data: {
                    coreUserInfo: { userId: 5638496993, fansNum: 39 },
                  },
                },
              }
            : null,
        scrollToEnd: async () => ({
          found: true,
          moved: true,
          atEnd: true,
        }),
        dispose: () => undefined,
      }),
    ).resolves.toEqual({ followerCount: 39 });
  });

  it("maps the observed first page and cursor", () => {
    expect(
      parseKuaishouContentPage(
        {
          result: 1,
          data: {
            total: 12,
            nextCursor: "next-page-token",
            list: [
              {
                workId: "3xjhawhjq26avd9",
                userId: 5638496993,
                title: "测试",
                publishCoverUrl: "https://p.example/cover.jpg",
                playCount: 1,
                likeCount: 0,
                commentCount: 0,
                uploadTime: 1788940290969,
                durationSecond: 10,
                publishStatus: 4,
              },
            ],
          },
        },
        "5638496993",
      ),
    ).toMatchObject({
      nextCursor: "next-page-token",
      total: 12,
      items: [
        {
          externalContentId: "3xjhawhjq26avd9",
          contentUrl: "https://www.kuaishou.com/short-video/3xjhawhjq26avd9",
          contentType: "video",
          platformStatus: "4",
          metrics: { viewCount: 1, likeCount: 0, commentCount: 0 },
        },
      ],
    });
  });

  it("scrolls for later pages, advances the cursor and deduplicates works", async () => {
    const events: string[] = [];
    const responses = [
      {
        status: 200,
        ok: true,
        body: {
          result: 1,
          data: {
            total: 3,
            nextCursor: "cursor-2",
            list: [
              { workId: "content-1", userId: 42 },
              { workId: "content-2", userId: 42 },
            ],
          },
        },
      },
      {
        status: 200,
        ok: true,
        body: {
          result: 1,
          data: {
            total: 3,
            list: [
              { workId: "content-2", userId: 42 },
              { workId: "content-3", userId: 42 },
            ],
          },
        },
      },
    ];
    const waitForJsonResponse = vi.fn(async () => {
      events.push("wait");
      return responses.shift() ?? null;
    });
    const scrollToEnd = vi.fn(async () => {
      events.push("scroll");
      return { found: true, moved: true, atEnd: true };
    });
    const result = await kuaishouPlatformModule.content!.read(
      {
        navigate: async () => {
          events.push("navigate");
        },
        requestJson: async () => ({ status: 500, ok: false, body: null }),
        waitForJsonResponse,
        scrollToEnd,
        dispose: () => undefined,
      },
      "42",
    );

    expect(events).toEqual(["wait", "navigate", "wait", "scroll"]);
    expect(waitForJsonResponse).toHaveBeenNthCalledWith(2, {
      method: "POST",
      url: expect.stringContaining("/rest/cp/works/v2/video/pc/photo/list"),
      timeoutMs: 10_000,
      replayObserved: false,
    });
    expect(scrollToEnd).toHaveBeenCalledWith({ selector: "#main-container" });
    expect(result).toEqual({
      complete: true,
      pagesRead: 2,
      remoteTotal: 3,
      items: [
        expect.objectContaining({ externalContentId: "content-1" }),
        expect.objectContaining({ externalContentId: "content-2" }),
        expect.objectContaining({ externalContentId: "content-3" }),
      ],
    });
  });

  it("keeps collected pages partial when scrolling yields no next response", async () => {
    const waitForJsonResponse = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: {
          result: 1,
          data: {
            total: 2,
            nextCursor: "cursor-2",
            list: [{ workId: "content-1", userId: 42 }],
          },
        },
      })
      .mockResolvedValueOnce(null);
    const result = await kuaishouPlatformModule.content!.read(
      {
        navigate: async () => undefined,
        requestJson: async () => ({ status: 500, ok: false, body: null }),
        waitForJsonResponse,
        scrollToEnd: async () => ({
          found: true,
          moved: true,
          atEnd: true,
        }),
        dispose: () => undefined,
      },
      "42",
    );

    expect(result).toMatchObject({
      complete: false,
      pagesRead: 1,
      remoteTotal: 2,
      items: [{ externalContentId: "content-1" }],
    });
    expect(result.diagnostics?.[0]).toContain("未观察到下一页响应");
  });
});
