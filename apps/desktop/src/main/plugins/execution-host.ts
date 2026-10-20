import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  contextRequestPacer,
  openPinnedBrowserScriptHost,
  retryAfterMilliseconds,
  type OpenedBrowserContext,
} from "@nedia-matrix/automation-playwright";
import type {
  PlatformExecutionHost,
  PlatformJsonResponse,
} from "@nedia-matrix/platform-sdk";
import { openLocalVideo } from "./local-video.js";

export function createPlatformExecutionHost(input: {
  context: OpenedBrowserContext["context"];
  assetDirectory: string;
  assertOwnership(): void;
  /** Media references come from the task's authorized selection, never plugin input alone. */
  mediaReferences?: ReadonlySet<string>;
}): PlatformExecutionHost {
  const { context, assertOwnership } = input;
  const pacer = contextRequestPacer(context);
  const media = (reference: string) => {
    assertOwnership();
    if (!isAbsolute(reference) || !input.mediaReferences?.has(reference))
      throw new Error("插件没有读取此媒体的授权");
  };
  return {
    assertOwnership,
    cookies: async (url) => {
      assertOwnership();
      return context.cookies(url);
    },
    openScript: (options) => {
      assertOwnership();
      for (const asset of options.assets) {
        const child = relative(
          input.assetDirectory,
          resolve(input.assetDirectory, asset.name),
        );
        if (child.startsWith("..") || isAbsolute(child))
          throw new Error("插件资产路径越界");
      }
      return openPinnedBrowserScriptHost(context, {
        ...options,
        directory: input.assetDirectory,
      });
    },
    async requestJson(request) {
      assertOwnership();
      const response = await context.request.fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body !== undefined
          ? { data: Buffer.from(request.body, "utf8") }
          : {}),
        maxRedirects: 0,
        maxRetries: 0,
        timeout: Math.min(request.timeoutMs, 30_000),
        failOnStatusCode: false,
      });
      try {
        const bytes = await response.body();
        if (bytes.byteLength > 1_000_000) throw new Error("Response too large");
        return {
          status: response.status(),
          ok: response.ok(),
          body: JSON.parse(bytes.toString()) as unknown,
          retryAfterMs: retryAfterMilliseconds(
            response.headers()["retry-after"],
          ),
        };
      } finally {
        await response.dispose();
      }
    },
    async observeJson({
      pageUrl,
      responseUrl,
      signal,
    }): Promise<PlatformJsonResponse> {
      assertOwnership();
      signal?.throwIfAborted();
      const page = await context.newPage();
      const close = () => {
        void page.close().catch(() => {});
      };
      const timer = setTimeout(close, 10_000);
      signal?.addEventListener("abort", close, { once: true });
      if (signal?.aborted) close();
      try {
        const pending = page.waitForResponse(
          (r) =>
            r.url().split("?")[0] === responseUrl &&
            r.request().method() === "GET",
          { timeout: 10_000 },
        );
        void pending.catch(() => {});
        await page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: 10_000,
        });
        const response = await pending;
        const bytes = await response.body();
        if (bytes.byteLength > 1_000_000)
          throw new Error("Identity response too large");
        signal?.throwIfAborted();
        assertOwnership();
        return {
          status: response.status(),
          ok: response.ok(),
          body: JSON.parse(bytes.toString()) as unknown,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", close);
        await page.close().catch(() => {});
      }
    },
    pace: (signal, operation) => pacer.run(signal as AbortSignal, operation),
    rateLimited: (delay) => pacer.rateLimited(delay),
    async readImage(reference, signal) {
      signal.throwIfAborted();
      media(reference);
      const info = await stat(reference);
      if (!info.isFile() || info.size > 20 * 1024 * 1024)
        throw new Error("Image resource budget exceeded");
      return readFile(reference, { signal: signal as AbortSignal });
    },
    openVideo: (reference, signal) => {
      media(reference);
      return openLocalVideo(context, reference, signal as AbortSignal);
    },
  };
}
