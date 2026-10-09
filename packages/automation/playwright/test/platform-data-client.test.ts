import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";

import { createPlaywrightPlatformDataClient } from "../src/index.js";
import { pageInteractionSession } from "../src/human-interaction.js";

function fixture() {
  const events = new EventEmitter();
  const goto = vi.fn(async () => undefined);
  const fetch = vi.fn(async () => ({
    url: () => "https://creator.example.test/api/items",
    status: () => 200,
    ok: () => true,
    headers: () => ({}),
    dispose: async () => undefined,
    body: async () => Buffer.from('{"value":42}'),
  }));
  const context = { request: { fetch } };
  const page = Object.assign(events, {
    context: () => context,
    isClosed: () => false,
    mouse: {
      move: vi.fn(async () => undefined),
      wheel: vi.fn(async (_x: number, _y: number): Promise<void> => undefined),
    },
    goto,
    url: () => "https://creator.example.test/home",
    evaluate: vi.fn(async () => ({ width: 1366, height: 768 })),
    locator: vi.fn(),
  });
  const client = createPlaywrightPlatformDataClient(
    context as never,
    page as never,
    {
      startUrl: "https://creator.example.test/home",
      allowedHostSuffixes: ["example.test"],
    },
  );
  return { client, events, fetch, goto, page };
}

describe("Playwright platform data client", () => {
  it("classifies a transport failure without replaying the request or exposing its URL", async () => {
    const { client, fetch, page } = fixture();
    const cause = new Error(
      "network failed: https://creator.example.test/api/items?token=secret",
    );
    fetch.mockRejectedValueOnce(cause);
    try {
      await expect(
        client.requestJson({
          method: "GET",
          url: "https://creator.example.test/api/items",
        }),
      ).rejects.toMatchObject({
        name: "PlatformDataOperationError",
        code: "request_failed",
        message: "platform_request_failed",
        cause,
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(page.evaluate).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("classifies response body transport failures and disposes the response", async () => {
    const { client, fetch } = fixture();
    const response = await fetch.getMockImplementation()!();
    const dispose = vi.fn(async () => undefined);
    fetch.mockResolvedValueOnce({
      ...response,
      dispose,
      body: async () => {
        throw new Error("connection reset");
      },
    });
    try {
      await expect(
        client.requestJson({
          method: "GET",
          url: "https://creator.example.test/api/items",
        }),
      ).rejects.toMatchObject({ code: "request_failed" });
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
  });

  it("preserves cancellation rather than classifying it as a request failure", async () => {
    const { client, fetch } = fixture();
    fetch.mockImplementationOnce(async () => {
      client.dispose();
      throw new Error("transport stopped");
    });
    await expect(
      client.requestJson({
        method: "GET",
        url: "https://creator.example.test/api/items",
      }),
    ).rejects.toMatchObject({
      name: "Error",
      message: "Platform data client disposed",
    });
  });

  it("does not classify an oversized response as an operational failure", async () => {
    const { client, fetch } = fixture();
    const response = await fetch.getMockImplementation()!();
    fetch.mockResolvedValueOnce({
      ...response,
      body: async () => Buffer.alloc(2_000_001),
    });
    try {
      await expect(
        client.requestJson({
          method: "GET",
          url: "https://creator.example.test/api/items",
        }),
      ).rejects.toMatchObject({
        name: "Error",
        message: "Platform data response is too large",
      });
    } finally {
      client.dispose();
    }
  });

  it.each(["legacy", "response"])(
    "classifies an unavailable scroll target and cleans up the %s operation",
    async (mode) => {
      const { client, page } = fixture();
      page.locator.mockReturnValue({
        first: () => ({
          count: async () => 1,
          evaluate: async () => ({ top: 0, height: 600, client: 200 }),
          scrollIntoViewIfNeeded: async () => undefined,
          boundingBox: async () => null,
        }),
      });
      try {
        const operation =
          mode === "legacy"
            ? client.scrollToEnd({ selector: ".content" })
            : client.scrollForJsonResponse!({
                selector: ".content",
                response: {
                  method: "GET",
                  url: "https://creator.example.test/api/items",
                  timeoutMs: 10_000,
                },
              });
        await expect(operation).rejects.toBeInstanceOf(
          PlatformDataOperationError,
        );
        expect(page.mouse.wheel).not.toHaveBeenCalled();
        expect(page.listenerCount("response")).toBe(1);
      } finally {
        client.dispose();
      }
      expect(page.listenerCount("response")).toBe(0);
    },
  );
  it("starts the first-page response budget after account input work leaves the queue", async () => {
    vi.useFakeTimers();
    try {
      const { client, page, events, goto } = fixture();
      let release!: () => void;
      const input = pageInteractionSession(page as never).run(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await Promise.resolve();
      goto.mockImplementation(async () => {
        events.emit("response", {
          request: () => ({ method: () => "GET", resourceType: () => "xhr" }),
          url: () => "https://creator.example.test/api/items",
          status: () => 200,
          ok: () => true,
          headers: () => ({}),
          body: async () => Buffer.from('{"items":[1]}'),
        });
      });
      const read = client.navigateForJsonResponses!({
        url: "https://creator.example.test/home",
        responses: [
          {
            method: "GET",
            url: "https://creator.example.test/api/items",
            timeoutMs: 50,
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(goto).not.toHaveBeenCalled();
      release();
      await input;
      await expect(read).resolves.toEqual([
        { status: 200, ok: true, body: { items: [1] } },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses the persistent context request and parses JSON", async () => {
    const { client, fetch } = fixture();
    await expect(
      client.requestJson({
        method: "GET",
        url: "https://creator.example.test/api/items",
      }),
    ).resolves.toEqual({ status: 200, ok: true, body: { value: 42 } });
    expect(fetch).toHaveBeenCalledWith(
      "https://creator.example.test/api/items",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("matches observed responses by method, origin and path", async () => {
    const { client, events } = fixture();
    const waiting = client.waitForJsonResponse({
      method: "POST",
      url: "https://creator.example.test/api/items",
      timeoutMs: 100,
    });
    events.emit("response", {
      request: () => ({ method: () => "POST", resourceType: () => "xhr" }),
      url: () => "https://creator.example.test/api/items?page=1",
      status: () => 200,
      ok: () => true,
      headers: () => ({}),
      body: async () => Buffer.from('{"items":[]}'),
    });
    await expect(waiting).resolves.toEqual({
      status: 200,
      ok: true,
      body: { items: [] },
    });
  });

  it("replays a recent observed response to a later reader", async () => {
    const { client, events } = fixture();
    events.emit("response", {
      request: () => ({ method: () => "POST", resourceType: () => "xhr" }),
      url: () => "https://creator.example.test/api/profile?from=home",
      status: () => 200,
      ok: () => true,
      headers: () => ({}),
      body: async () => Buffer.from('{"data":{"userId":"42"}}'),
    });

    await expect(
      client.waitForJsonResponse({
        method: "POST",
        url: "https://creator.example.test/api/profile",
        timeoutMs: 100,
      }),
    ).resolves.toEqual({
      status: 200,
      ok: true,
      body: { data: { userId: "42" } },
    });
  });

  it("can wait only for the next matching response", async () => {
    const { client, events } = fixture();
    const response = {
      request: () => ({ method: () => "GET", resourceType: () => "fetch" }),
      url: () => "https://creator.example.test/api/items?page=0",
      status: () => 200,
      ok: () => true,
      headers: () => ({}),
      body: async () => Buffer.from('{"page":0}'),
    };
    events.emit("response", response);

    const waiting = client.waitForJsonResponse({
      method: "GET",
      url: "https://creator.example.test/api/items",
      timeoutMs: 100,
      replayObserved: false,
    });
    events.emit("response", {
      ...response,
      url: () => "https://creator.example.test/api/items?page=1",
      headers: () => ({}),
      body: async () => Buffer.from('{"page":1}'),
    });

    await expect(waiting).resolves.toEqual({
      status: 200,
      ok: true,
      body: { page: 1 },
    });
  });

  it("uses wheel input to reach the original container end without DOM scrollTo", async () => {
    const { client, page } = fixture();
    const element = { scrollTop: 10, scrollHeight: 600, clientHeight: 200 };
    const evaluate = vi.fn(async (callback, argument) =>
      argument ? true : callback(element),
    );
    const target = {
      count: async () => 1,
      evaluate,
      isEnabled: async () => true,
      boundingBox: async () => ({ x: 0, y: 0, width: 500, height: 200 }),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    };
    page.locator.mockReturnValue({ first: () => target });
    page.mouse.wheel.mockImplementation(async (_x: number, y: number) => {
      element.scrollTop = Math.min(400, element.scrollTop + y);
    });
    await expect(client.scrollToEnd({ selector: ".content" })).resolves.toEqual(
      { found: true, moved: true, atEnd: true },
    );
    expect(page.mouse.wheel).toHaveBeenCalled();
    expect(page.locator).toHaveBeenCalledWith(".content");
    client.dispose();
  });

  it("rejects navigation and requests outside the platform boundary", async () => {
    const { client } = fixture();
    await expect(client.navigate("https://example.invalid/")).rejects.toThrow(
      "outside the platform boundary",
    );
    await expect(
      client.requestJson({ method: "GET", url: "https://example.invalid/" }),
    ).rejects.toThrow("outside the platform boundary");
  });
});
