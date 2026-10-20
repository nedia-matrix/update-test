import {
  isPlatformDataOperationError,
  type PlatformExecutionHost,
} from "@nedia-matrix/platform-sdk";
import {
  PlatformDataOperationError,
  type PlatformDataClient,
} from "@nedia-matrix/platform-sdk";
import {
  isXhsSignedEndpoint,
  xhsNoteEndpoint,
  xhsVideoPermitEndpoint,
  xhsImagePermitEndpoint,
} from "../signed-api/index.js";
import { openXhsSignedTransport } from "./signed-transport.js";

/** Read-only signed requests. The owner must await close before releasing the Profile. */
export function createXhsSignedDataClient(
  base: PlatformDataClient,
  host: PlatformExecutionHost,
  assertOwnership: () => void,
): { dataClient: PlatformDataClient; close(): Promise<void> } {
  const controller = new AbortController();
  const pacer = { run: host.pace, rateLimited: host.rateLimited };
  let transport: ReturnType<typeof openXhsSignedTransport> | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const check = () => {
    controller.signal.throwIfAborted();
    assertOwnership();
  };
  const dataClient: PlatformDataClient = {
    ...base,
    requestJson(request) {
      if (
        request.method !== "GET" ||
        request.body !== undefined ||
        !isXhsSignedEndpoint(request.url) ||
        request.url === xhsNoteEndpoint ||
        request.url === xhsImagePermitEndpoint ||
        request.url === xhsVideoPermitEndpoint
      )
        return Promise.reject(new Error("Unsupported XHS data endpoint"));
      const pending = pacer.run(controller.signal, async () => {
        check();
        transport ??= openXhsSignedTransport(host, check, {
          pinSession: true,
        });
        const client = await transport;
        check();
        try {
          const send = await client.sign(request.url, "", controller.signal);
          const response = await send();
          check();
          if (response.status === 429) pacer.rateLimited(response.retryAfterMs);
          return response;
        } catch (error) {
          check();
          if (isPlatformDataOperationError(error)) throw error;
          throw new PlatformDataOperationError(
            "request_failed",
            "小红书接口请求失败",
          );
        }
      });
      active.add(pending);
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      );
      return pending;
    },
    dispose() {
      controller.abort(new Error("XHS data client closed"));
      base.dispose();
    },
  };
  return {
    dataClient,
    close() {
      return (closing ??= (async () => {
        dataClient.dispose();
        await Promise.allSettled([...active]);
        const client = await transport?.catch(() => undefined);
        await client?.close();
      })());
    },
  };
}
