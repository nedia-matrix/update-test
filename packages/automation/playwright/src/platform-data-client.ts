import type {
  PlatformBrowserPolicy,
  PlatformDataClient,
  PlatformJsonResponse,
  PlatformObservedJsonRequest,
} from "@nedia-matrix/platform-sdk";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";
import type { BrowserContext, Page, Response } from "playwright";

import {
  abortableWait,
  sampleTiming,
  pageInteractionSession,
} from "./human-interaction.js";
import {
  contextRequestPacer,
  retryAfterMilliseconds,
} from "./request-pacing.js";
import { wheelScroll } from "./wheel-scroll.js";
import { isAllowedPlatformNavigation } from "./navigation-policy.js";

const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const OBSERVED_RESPONSE_REPLAY_WINDOW_MS = 10_000;
const MAX_OBSERVED_RESPONSES = 100;

function responseKey(method: string, url: string): string {
  const parsed = new URL(url);
  return `${method.toUpperCase()} ${parsed.origin}${parsed.pathname}`;
}

function parseResponse(
  status: number,
  ok: boolean,
  body: Buffer,
  retryAfterMs?: number,
): PlatformJsonResponse {
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Platform data response is too large");
  }
  try {
    return {
      status,
      ok,
      body: JSON.parse(body.toString("utf8")) as unknown,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch {
    return {
      status,
      ok,
      body: null,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
}

async function parseObservedResponse(
  response: Response,
): Promise<PlatformJsonResponse | null> {
  try {
    return parseResponse(
      response.status(),
      response.ok(),
      await response.body(),
      retryAfterMilliseconds(response.headers()["retry-after"]),
    );
  } catch {
    return null;
  }
}

export function createPlaywrightPlatformDataClient(
  context: BrowserContext,
  page: Page,
  browser: PlatformBrowserPolicy,
): PlatformDataClient {
  const interaction = pageInteractionSession(page);
  const controller = new AbortController();
  const pacer = contextRequestPacer(context);
  const waiters = new Map<
    string,
    Set<(response: PlatformJsonResponse | null) => void>
  >();
  const observedResponses = new Map<
    string,
    { response: Response; observedAt: number }
  >();
  let disposed = false;

  const handleResponse = (response: Response) => {
    if (disposed) return;
    const request = response.request();
    if (!isAllowedPlatformNavigation(response.url(), browser)) return;
    const resourceType = request.resourceType();
    if (resourceType !== "fetch" && resourceType !== "xhr") return;
    const now = Date.now();
    for (const [key, observed] of observedResponses) {
      if (now - observed.observedAt > OBSERVED_RESPONSE_REPLAY_WINDOW_MS) {
        observedResponses.delete(key);
      }
    }
    const key = responseKey(request.method(), response.url());
    observedResponses.delete(key);
    observedResponses.set(key, { response, observedAt: now });
    while (observedResponses.size > MAX_OBSERVED_RESPONSES) {
      const oldestKey = observedResponses.keys().next().value;
      if (oldestKey === undefined) break;
      observedResponses.delete(oldestKey);
    }
    const listeners = waiters.get(key);
    if (response.status() === 429)
      pacer.rateLimited(
        retryAfterMilliseconds(response.headers()["retry-after"]),
      );
    if (!listeners?.size) return;
    waiters.delete(key);
    const snapshot = [...listeners];
    void parseObservedResponse(response).then((parsed) => {
      if (response.status() === 429) pacer.rateLimited(parsed?.retryAfterMs);
      for (const resolve of snapshot) resolve(parsed);
    });
  };

  page.on("response", handleResponse);

  function observe(
    request: PlatformObservedJsonRequest,
    signal: AbortSignal = controller.signal,
  ): Promise<PlatformJsonResponse | null> {
    if (disposed || signal.aborted) return Promise.resolve(null);
    if (!isAllowedPlatformNavigation(request.url, browser))
      return Promise.reject(
        new Error("Platform data response is outside the platform boundary"),
      );
    const key = responseKey(request.method, request.url);
    const observed = observedResponses.get(key);
    if (
      request.replayObserved !== false &&
      observed &&
      Date.now() - observed.observedAt <= OBSERVED_RESPONSE_REPLAY_WINDOW_MS
    )
      return parseObservedResponse(observed.response);
    observedResponses.delete(key);
    return new Promise((resolve) => {
      const listeners = waiters.get(key) ?? new Set();
      waiters.set(key, listeners);
      let settled = false;
      const abort = () => finish(null);
      const finish = (response: PlatformJsonResponse | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", abort);
        listeners.delete(finish);
        if (waiters.get(key) === listeners && listeners.size === 0)
          waiters.delete(key);
        resolve(response);
      };
      const timer = setTimeout(() => finish(null), request.timeoutMs);
      listeners.add(finish);
      signal.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", abort, { once: true });
    });
  }
  const check = () => {
    controller.signal.throwIfAborted();
    interaction.check();
    pacer.assertAllowed();
  };
  const operationFailure = (
    code: "request_failed" | "scroll_failed",
    error: unknown,
  ): never => {
    // Revocation must propagate instead of being saved as a partial sync.
    controller.signal.throwIfAborted();
    interaction.check();
    if (error instanceof PlatformDataOperationError) throw error;
    throw new PlatformDataOperationError(code, `platform_${code}`, {
      cause: error,
    });
  };
  async function dataOperation<T>(
    code: "request_failed" | "scroll_failed",
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      return operationFailure(code, error);
    }
  }
  const onClose = () =>
    controller.abort(new Error("Platform data page closed"));
  const onRevoke = () => controller.abort(interaction.signal.reason);
  page.once("close", onClose);
  interaction.signal.addEventListener("abort", onRevoke, { once: true });

  return {
    async navigateForJsonResponses(request) {
      if (
        ![
          request.url,
          ...request.responses.map((response) => response.url),
        ].every((url) => isAllowedPlatformNavigation(url, browser))
      )
        throw new Error(
          "Platform data navigation is outside the platform boundary",
        );
      check();
      return interaction.run(async () => {
        check();
        const pending = new AbortController();
        const responses = Promise.all(
          request.responses.map((response) =>
            observe({ ...response, replayObserved: false }, pending.signal),
          ),
        );
        try {
          await page.goto(request.url, {
            waitUntil: "domcontentloaded",
            signal: controller.signal,
          });
          return await responses;
        } finally {
          pending.abort();
        }
      });
    },
    async navigate(url) {
      if (!isAllowedPlatformNavigation(url, browser)) {
        throw new Error(
          "Platform data navigation is outside the platform boundary",
        );
      }
      check();
      await interaction.run(async () => {
        check();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          signal: controller.signal,
        });
      });
    },
    async requestJson(request) {
      if (!isAllowedPlatformNavigation(request.url, browser)) {
        throw new Error(
          "Platform data request is outside the platform boundary",
        );
      }
      const options = {
        method: request.method,
        headers: { Accept: "application/json" },
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        failOnStatusCode: false,
        ...(request.body === undefined ? {} : { data: request.body }),
      };
      check();
      const direct = await pacer.run(controller.signal, async () => {
        const response = await dataOperation("request_failed", () =>
          context.request.fetch(request.url, {
            ...options,
            maxRedirects: 0,
          }),
        );
        try {
          if (!isAllowedPlatformNavigation(response.url(), browser))
            throw new Error(
              "Platform data response is outside the platform boundary",
            );
          const retryAfterMs = retryAfterMilliseconds(
            response.headers()["retry-after"],
          );
          if (response.status() === 429) pacer.rateLimited(retryAfterMs);
          return parseResponse(
            response.status(),
            response.ok(),
            await dataOperation("request_failed", () => response.body()),
            retryAfterMs,
          );
        } finally {
          await response.dispose();
        }
      });
      controller.signal.throwIfAborted();
      interaction.check();
      if (direct.ok && direct.body !== null) return direct;
      // Only known transport compatibility errors can use the page-fetch fallback.
      // Authentication, rate limits, server failures and HTML challenges never trigger another request.
      if (![404, 405].includes(direct.status)) return direct;
      if (new URL(page.url()).origin !== new URL(request.url).origin) {
        return direct;
      }
      const pageResponse = await pacer.run(controller.signal, () =>
        dataOperation("request_failed", () =>
          page.evaluate(
            async ({ input, maxBytes }) => {
              const controller = new AbortController();
              const timer = setTimeout(
                () => controller.abort(),
                input.timeoutMs ?? 10_000,
              );
              try {
                const result = await fetch(input.url, {
                  method: input.method,
                  credentials: "include",
                  cache: "no-store",
                  headers: {
                    Accept: "application/json",
                    ...(input.body === undefined
                      ? {}
                      : { "Content-Type": "application/json" }),
                  },
                  ...(input.body === undefined
                    ? {}
                    : { body: JSON.stringify(input.body) }),
                  signal: controller.signal,
                });
                return {
                  url: result.url,
                  status: result.status,
                  ok: result.ok,
                  retryAfter: result.headers.get("retry-after") ?? undefined,
                  text: (await result.text()).slice(0, maxBytes + 1),
                };
              } finally {
                clearTimeout(timer);
              }
            },
            { input: request, maxBytes: MAX_RESPONSE_BYTES },
          ),
        ),
      );
      check();
      if (!isAllowedPlatformNavigation(pageResponse.url, browser)) {
        throw new Error(
          "Platform data response is outside the platform boundary",
        );
      }
      const parsed = parseResponse(
        pageResponse.status,
        pageResponse.ok,
        Buffer.from(pageResponse.text),
        retryAfterMilliseconds(pageResponse.retryAfter),
      );
      if (parsed.status === 429) pacer.rateLimited(parsed.retryAfterMs);
      return parsed;
    },
    waitForJsonResponse: observe,
    async scrollToEnd(request) {
      check();
      return interaction.run(() => {
        check();
        return dataOperation("scroll_failed", () =>
          wheelScroll(
            page,
            request.selector,
            interaction,
            Date.now() + 10_000,
            () => disposed,
          ),
        );
      });
    },
    async scrollForJsonResponse(request) {
      check();
      return interaction.run(async () => {
        // Pace before subscribing, so the response budget is not consumed by this pause.
        check();
        await abortableWait(
          sampleTiming("scroll", interaction.random),
          controller.signal,
        );
        check();
        const pending = new AbortController();
        const key = responseKey(request.response.method, request.response.url);
        let received = false;
        const onResponse = (response: Response) => {
          if (
            responseKey(response.request().method(), response.url()) === key &&
            ["xhr", "fetch"].includes(response.request().resourceType())
          )
            received = true;
        };
        page.on("response", onResponse);
        const responsePromise = observe(
          { ...request.response, replayObserved: false },
          pending.signal,
        );
        try {
          const scroll = await wheelScroll(
            page,
            request.selector,
            interaction,
            Date.now() + request.response.timeoutMs,
            () => received || disposed,
          );
          if (!scroll.found) pending.abort();
          return { scroll, response: await responsePromise };
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "interaction_timeout"
          ) {
            return {
              scroll: { found: true, moved: false, atEnd: false },
              response: null,
            };
          }
          return operationFailure("scroll_failed", error);
        } finally {
          pending.abort();
          page.off("response", onResponse);
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort(new Error("Platform data client disposed"));
      page.off("close", onClose);
      interaction.signal.removeEventListener("abort", onRevoke);
      page.off("response", handleResponse);
      observedResponses.clear();
      for (const listeners of waiters.values()) {
        for (const resolve of listeners) resolve(null);
      }
      waiters.clear();
    },
  };
}
