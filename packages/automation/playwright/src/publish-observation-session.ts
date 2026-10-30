import type {
  ObservedHttpRequest,
  ObservedHttpResponse,
  PublishObservationSession,
} from "@nedia-matrix/platform-sdk";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

const MAX_OBSERVED_RESPONSE_BYTES = 2_000_000;

function assertByteLimit(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Response byte limit must be a positive integer");
  }
  if (maxBytes > MAX_OBSERVED_RESPONSE_BYTES) {
    throw new RangeError("Response byte limit exceeds the adapter maximum");
  }
}

interface ObservedBodyTracker {
  addBytes(byteLength: number): void;
  finish(): void;
  fail(): void;
  readText(maxBytes: number): Promise<string>;
}

function createObservedBodyTracker(
  cdp: CDPSession,
  requestId: string,
  status: number,
): ObservedBodyTracker {
  let byteLength = 0;
  let sawData = false;
  let resolveCompletion: (result: "finished" | "failed") => void = () =>
    undefined;
  const completion = new Promise<"finished" | "failed">((resolve) => {
    resolveCompletion = resolve;
  });

  return {
    addBytes(chunkByteLength) {
      sawData = true;
      byteLength += chunkByteLength;
    },
    finish() {
      resolveCompletion("finished");
    },
    fail() {
      resolveCompletion("failed");
    },
    async readText(maxBytes) {
      assertByteLimit(maxBytes);
      const result = await completion;
      if (result === "failed") {
        throw new Error("Observed response body could not be read");
      }
      if (!sawData && status !== 204 && status !== 304) {
        throw new Error("Observed response body size could not be bounded");
      }
      if (byteLength > maxBytes) {
        throw new Error("Observed response body exceeded its byte limit");
      }
      if (!sawData) return "";
      const responseBody = await cdp.send("Network.getResponseBody", {
        requestId,
      });
      const buffer = Buffer.from(
        responseBody.body,
        responseBody.base64Encoded ? "base64" : "utf8",
      );
      if (buffer.byteLength > maxBytes) {
        throw new Error("Observed response body exceeded its byte limit");
      }
      return buffer.toString("utf8");
    },
  };
}

export async function createPlaywrightPublishObservationSession(
  context: BrowserContext,
  page: Page,
): Promise<PublishObservationSession & { dispose(): Promise<void> }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const requestMethods = new Map<string, string>();
  const responseBodies = new Map<string, ObservedBodyTracker>();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    requestMethods.set(requestId, request.method);
  });
  cdp.on("Network.dataReceived", ({ requestId, dataLength }) => {
    responseBodies.get(requestId)?.addBytes(dataLength);
  });
  cdp.on("Network.loadingFinished", ({ requestId }) => {
    responseBodies.get(requestId)?.finish();
    responseBodies.delete(requestId);
    requestMethods.delete(requestId);
  });
  cdp.on("Network.loadingFailed", ({ requestId }) => {
    responseBodies.get(requestId)?.fail();
    responseBodies.delete(requestId);
    requestMethods.delete(requestId);
  });
  const failPendingBodies = () => {
    for (const tracker of responseBodies.values()) tracker.fail();
    responseBodies.clear();
    requestMethods.clear();
  };
  page.once("close", failPendingBodies);
  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      page.off("close", failPendingBodies);
      failPendingBodies();
      await cdp.detach();
    },
    requests: {
      subscribe(listener) {
        const handleRequest = ({
          request,
        }: Parameters<
          Parameters<typeof cdp.on<"Network.requestWillBeSent">>[1]
        >[0]): void => {
          const observed: ObservedHttpRequest = {
            method: request.method,
            url: request.url,
          };
          listener(observed);
        };
        cdp.on("Network.requestWillBeSent", handleRequest);
        return () => cdp.off("Network.requestWillBeSent", handleRequest);
      },
    },
    responses: {
      subscribe(listener) {
        const handleResponse = ({
          requestId,
          response,
        }: Parameters<
          Parameters<typeof cdp.on<"Network.responseReceived">>[1]
        >[0]): void => {
          const bodyTracker = createObservedBodyTracker(
            cdp,
            requestId,
            response.status,
          );
          responseBodies.set(requestId, bodyTracker);
          const observed: ObservedHttpResponse = {
            method: requestMethods.get(requestId) ?? "GET",
            url: response.url,
            status: response.status,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([name, value]) => [
                name.toLowerCase(),
                String(value),
              ]),
            ),
            readText: (maxBytes) => bodyTracker.readText(maxBytes),
          };
          listener(observed);
        };
        cdp.on("Network.responseReceived", handleResponse);
        return () => cdp.off("Network.responseReceived", handleResponse);
      },
    },
    page: {
      isTextVisible: (text) =>
        page.getByText(text, { exact: true }).isVisible(),
      subscribeClose(listener) {
        page.on("close", listener);
        return () => page.off("close", listener);
      },
    },
  };
}
