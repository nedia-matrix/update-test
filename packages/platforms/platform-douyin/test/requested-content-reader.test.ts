import { describe, expect, it, vi } from "vitest";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";

import { douyinRequestedContentCapability } from "../src/index.js";

function response(body: unknown) {
  return { status: 200, ok: true, body };
}

describe("Douyin requested content reader", () => {
  const firstPage = response({
    status_code: 0,
    has_more: true,
    max_cursor: "cursor-2",
    total: 2,
    aweme_list: [{ aweme_id: "content-1" }],
  });
  const client = (requestJson: ReturnType<typeof vi.fn>) => ({
    navigate: async () => undefined,
    requestJson,
    waitForJsonResponse: async () => null,
    scrollToEnd: async () => ({ found: true, moved: false, atEnd: false }),
    dispose: () => undefined,
  });
  it.each([
    { code: "rate_limited", reason: "平台请求受限" },
    { code: "request_failed", reason: "网络请求失败" },
  ] as const)(
    "retains verified pages after $code without retrying or exposing request details",
    async ({ code, reason }) => {
      const requestJson = vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockRejectedValueOnce(
          new PlatformDataOperationError(
            code,
            "https://creator.example/api?token=secret",
          ),
        );
      await expect(
        douyinRequestedContentCapability.read(client(requestJson), "account-1"),
      ).resolves.toMatchObject({
        complete: false,
        pagesRead: 1,
        remoteTotal: 2,
        items: [{ externalContentId: "content-1" }],
        diagnostics: [expect.stringContaining(reason)],
      });
      expect(requestJson).toHaveBeenCalledTimes(2);
    },
  );
  it("fails when no page was read and propagates cancellation after a page", async () => {
    const rateLimit = new PlatformDataOperationError(
      "rate_limited",
      "platform_rate_limited",
    );
    await expect(
      douyinRequestedContentCapability.read(
        client(vi.fn().mockRejectedValue(rateLimit)),
        "account-1",
      ),
    ).rejects.toBe(rateLimit);
    const cancelled = new Error("页面控制权已移交或自动操作已取消");
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(cancelled);
    await expect(
      douyinRequestedContentCapability.read(client(requestJson), "account-1"),
    ).rejects.toBe(cancelled);
  });
  it("does not turn a later account mismatch into a partial success", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(
        response({
          status_code: 0,
          has_more: false,
          aweme_list: [
            { aweme_id: "content-2", author: { short_id: "another-account" } },
          ],
        }),
      );
    await expect(
      douyinRequestedContentCapability.read(client(requestJson), "account-1"),
    ).rejects.toThrow("账号与当前登录账号不一致");
  });
  it("requests cursor pages with GET and deduplicates overlapping items", async () => {
    const navigate = vi.fn(async () => undefined);
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          status_code: 0,
          has_more: true,
          max_cursor: "cursor-2",
          total: 3,
          aweme_list: [{ aweme_id: "content-1" }, { aweme_id: "content-2" }],
        }),
      )
      .mockResolvedValueOnce(
        response({
          status_code: 0,
          has_more: false,
          max_cursor: "cursor-3",
          total: 3,
          aweme_list: [{ aweme_id: "content-2" }, { aweme_id: "content-3" }],
        }),
      );

    const result = await douyinRequestedContentCapability.read(
      {
        navigate,
        requestJson,
        waitForJsonResponse: async () => null,
        dispose: () => undefined,
      },
      "account-1",
    );

    expect(navigate).toHaveBeenCalledWith(
      "https://creator.douyin.com/creator-micro/content/manage",
    );
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining("max_cursor=0"),
      }),
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining("max_cursor=cursor-2"),
      }),
    ]);
    expect(result).toMatchObject({
      complete: true,
      pagesRead: 2,
      remoteTotal: 3,
    });
    expect(result.items.map((item) => item.externalContentId)).toEqual([
      "content-1",
      "content-2",
      "content-3",
    ]);
  });

  it("keeps completed pages when a later request fails", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          status_code: 0,
          has_more: true,
          max_cursor: "cursor-2",
          total: 2,
          aweme_list: [{ aweme_id: "content-1" }],
        }),
      )
      .mockResolvedValueOnce({ status: 503, ok: false, body: null });

    const result = await douyinRequestedContentCapability.read(
      {
        navigate: async () => undefined,
        requestJson,
        waitForJsonResponse: async () => null,
        dispose: () => undefined,
      },
      "account-1",
    );

    expect(result).toMatchObject({
      complete: false,
      pagesRead: 1,
      remoteTotal: 2,
      items: [{ externalContentId: "content-1" }],
      diagnostics: ["抖音作品第 2 页请求失败（HTTP 503）"],
    });
  });

  it("stops when the response cursor does not advance", async () => {
    const requestJson = vi.fn(async () =>
      response({
        status_code: 0,
        has_more: true,
        max_cursor: "0",
        aweme_list: [{ aweme_id: "content-1" }],
      }),
    );

    const result = await douyinRequestedContentCapability.read(
      {
        navigate: async () => undefined,
        requestJson,
        waitForJsonResponse: async () => null,
        dispose: () => undefined,
      },
      "account-1",
    );

    expect(requestJson).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      complete: false,
      pagesRead: 1,
      diagnostics: ["抖音作品游标未前进，已停止同步"],
    });
  });
});
