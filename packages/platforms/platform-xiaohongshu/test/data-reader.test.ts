import { describe, expect, it, vi } from "vitest";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";

import {
  xiaohongshuPlatformModule,
  parseXiaohongshuAccountProfile,
  parseXiaohongshuContentPage,
} from "../src/index.js";

describe("Xiaohongshu data reader", () => {
  const client = (scrollForJsonResponse: ReturnType<typeof vi.fn>) => ({
    navigate: async () => undefined,
    navigateForJsonResponses: async () => [
      {
        status: 200,
        ok: true,
        body: {
          success: true,
          code: 0,
          data: {
            tags: [{ id: "special.note_time_desc", notes_count: 2 }],
            notes: [{ id: "content-1", type: "video" }],
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
        xiaohongshuPlatformModule.content!.read(client(scroll), "account-1"),
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
  it("propagates cancellation and response validation failures", async () => {
    const cancelled = new Error("页面控制权已移交或自动操作已取消");
    await expect(
      xiaohongshuPlatformModule.content!.read(
        client(vi.fn().mockRejectedValue(cancelled)),
        "account-1",
      ),
    ).rejects.toBe(cancelled);
    const scroll = vi.fn().mockResolvedValue({
      scroll: { found: true, moved: true, atEnd: false },
      response: { status: 200, ok: true, body: { success: false, code: 100 } },
    });
    await expect(
      xiaohongshuPlatformModule.content!.read(client(scroll), "account-1"),
    ).rejects.toThrow("作品列表响应失败");
  });
  it("maps profile counters", () => {
    expect(
      parseXiaohongshuAccountProfile({
        data: {
          personal_desc: "简介",
          fans_count: 8,
          follow_count: 4,
          notes_count: 9,
          faved_count: 102,
        },
      }),
    ).toEqual({
      description: "简介",
      followerCount: 8,
      followingCount: 4,
      contentCount: 9,
      likeCount: 102,
    });
  });

  it("reads profile data from the page response without issuing an unsigned API request", async () => {
    const events: string[] = [];
    const requestJson = vi
      .fn()
      .mockResolvedValue({ status: 403, ok: false, body: null });
    const waitForJsonResponse = vi.fn(async () => {
      events.push("wait");
      return {
        status: 200,
        ok: true,
        body: { data: { fans_count: 8, personal_desc: "简介" } },
      };
    });
    await expect(
      xiaohongshuPlatformModule.accountProfile!.read(
        {
          navigate: async () => {
            events.push("navigate");
          },
          requestJson,
          waitForJsonResponse,
          scrollToEnd: async () => ({ found: true, moved: false, atEnd: true }),
          dispose: () => undefined,
        },
        "account-1",
      ),
    ).resolves.toEqual({ followerCount: 8, description: "简介" });
    expect(events).toEqual(["wait", "navigate"]);
    expect(requestJson).not.toHaveBeenCalled();
    expect(waitForJsonResponse).toHaveBeenCalledWith({
      method: "GET",
      url: "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info",
      timeoutMs: 10_000,
    });
  });

  it("reports a missing profile response", async () => {
    await expect(
      xiaohongshuPlatformModule.accountProfile!.read(
        {
          ...client(vi.fn()),
          navigateForJsonResponses: async () => [null],
        },
        "account-1",
      ),
    ).rejects.toThrow("小红书账号资料响应未出现或请求失败");
  });

  it("maps note metrics and never carries the request token into storage", () => {
    const page = parseXiaohongshuContentPage({
      success: true,
      code: 0,
      data: {
        tags: [{ id: "special.note_time_desc", notes_count: 6 }],
        notes: [
          {
            id: "6a9f878e000000001203f51b",
            display_title: "早八多睡10分钟的秘密",
            type: "normal",
            visible_time: 1788839876,
            view_count: 20,
            likes: 2,
            comments_count: 0,
            shared_count: 0,
            collected_count: 2,
            tab_status: 1,
            xsec_token: "must-not-be-stored",
            images_list: [{ url: "http://sns.example/cover.jpg" }],
          },
        ],
      },
    });

    expect(page).toMatchObject({
      total: 6,
      items: [
        {
          externalContentId: "6a9f878e000000001203f51b",
          contentUrl:
            "https://www.xiaohongshu.com/explore/6a9f878e000000001203f51b",
          contentType: "image_text",
          coverUrl: "https://sns.example/cover.jpg",
          platformStatus: "1",
          metrics: {
            viewCount: 20,
            likeCount: 2,
            commentCount: 0,
            shareCount: 0,
            collectCount: 2,
          },
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("must-not-be-stored");
  });

  it("scrolls for later pages, ignores observed replays and deduplicates notes", async () => {
    const events: string[] = [];
    const requestJson = vi.fn();
    const responses = [
      {
        status: 200,
        ok: true,
        body: {
          success: true,
          code: 0,
          data: {
            tags: [{ id: "special.note_time_desc", notes_count: 3 }],
            notes: [
              { id: "content-1", type: "video" },
              { id: "content-2", type: "normal" },
            ],
          },
        },
      },
      {
        status: 200,
        ok: true,
        body: {
          success: true,
          code: 0,
          data: {
            tags: [{ id: "special.note_time_desc", notes_count: 3 }],
            notes: [
              { id: "content-2", type: "normal" },
              { id: "content-3", type: "video" },
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
    const result = await xiaohongshuPlatformModule.content!.read(
      {
        navigate: async () => {
          events.push("navigate");
        },
        requestJson,
        waitForJsonResponse,
        scrollToEnd,
        dispose: () => undefined,
      },
      "account-1",
    );

    expect(events).toEqual(["wait", "navigate", "wait", "scroll"]);
    expect(requestJson).not.toHaveBeenCalled();
    expect(waitForJsonResponse).toHaveBeenNthCalledWith(1, {
      method: "GET",
      url: expect.stringContaining("/api/galaxy/v2/creator/note/user/posted"),
      timeoutMs: 10_000,
    });
    expect(waitForJsonResponse).toHaveBeenNthCalledWith(2, {
      method: "GET",
      url: expect.stringContaining("/api/galaxy/v2/creator/note/user/posted"),
      timeoutMs: 10_000,
      replayObserved: false,
    });
    expect(scrollToEnd).toHaveBeenCalledWith({ selector: ".content" });
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
          success: true,
          code: 0,
          data: {
            tags: [{ id: "special.note_time_desc", notes_count: 2 }],
            notes: [{ id: "content-1", type: "video" }],
          },
        },
      })
      .mockResolvedValueOnce(null);
    const result = await xiaohongshuPlatformModule.content!.read(
      {
        navigate: async () => undefined,
        requestJson: vi.fn(),
        waitForJsonResponse,
        scrollToEnd: async () => ({
          found: true,
          moved: true,
          atEnd: true,
        }),
        dispose: () => undefined,
      },
      "account-1",
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
