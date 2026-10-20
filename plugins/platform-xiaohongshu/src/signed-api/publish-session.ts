import { buildXiaohongshuContentUrl } from "../shared/content-url.js";
import type {
  DirectPublishResult,
  PluginPublishSession,
  PublishAbortSignal,
} from "@nedia-matrix/platform-sdk";
import {
  prepareImageNote,
  type XhsImagePreparationPorts,
} from "./image-preparation.js";
import { checkCancellation } from "./errors.js";

export const xhsNoteEndpoint =
  "https://edith.xiaohongshu.com/web_api/sns/v2/note";
export interface XhsPublishSessionPorts extends XhsImagePreparationPorts {
  readLocalImage(reference: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Returns a one-shot send closure bound to the exact signed string and current account. No retries. */
  signNote(
    serializedBody: string,
    signal: AbortSignal,
  ): Promise<() => Promise<{ status: number; body: unknown }>>;
  close(): Promise<void>;
}

export function parseXhsNoteResponse(
  status: number,
  body: unknown,
): DirectPublishResult {
  const root = body as {
    code?: unknown;
    result?: unknown;
    success?: unknown;
    data?: { id?: unknown };
  } | null;
  // The creator note endpoint uses result=0; other API envelopes use code=0.
  // A conflicting/error field must never be overridden by a success marker.
  const markers = [root?.code, root?.result].filter((v) => v !== undefined);
  const accepted = markers.length > 0 && markers.every((v) => v === 0);
  if (status >= 200 && status < 300 && accepted && root?.success !== false) {
    const id = root?.data?.id;
    if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
      return {
        kind: "published",
        contentId: id,
        contentUrl: buildXiaohongshuContentUrl(id),
      };
    return {
      kind: "uncertain",
      message: "平台返回成功但未提供可确认的作品 ID",
    };
  }
  if (
    status >= 200 &&
    (status < 300 || status >= 400) &&
    status < 500 &&
    root &&
    markers.length > 0 &&
    markers.every((v) => typeof v === "number" && Number.isSafeInteger(v)) &&
    markers.every((v) => v !== 0)
  )
    return {
      kind: "failed",
      message: `平台明确拒绝发布（业务码 ${markers.join("/")}）`,
    };
  return { kind: "uncertain", message: "平台提交响应未能确认作品身份" };
}

export function createXhsPublishSession(
  ports: XhsPublishSessionPorts,
): PluginPublishSession {
  return createXhsPreparedPublishSession(ports, async (input, signal) => {
    const images = [];
    for (const [index, reference] of input.mediaReferences.entries()) {
      checkCancellation(signal);
      images.push({
        resourceId: `media-${index}`,
        bytes: await ports.readLocalImage(reference, signal),
      });
    }
    return prepareImageNote(
      { title: input.title, body: input.body, images },
      ports,
      { signal },
    );
  });
}

export function createXhsPreparedPublishSession(
  ports: Pick<XhsPublishSessionPorts, "verifyIdentity" | "signNote" | "close">,
  prepare: (
    input: Parameters<PluginPublishSession["prepare"]>[0],
    signal: AbortSignal,
  ) => Promise<{ readonly serializedBody: string }>,
): PluginPublishSession {
  let prepared: { readonly serializedBody: string } | undefined;
  let preparationStarted = false;
  let submissionStarted = false;
  let closed = false;
  return {
    async prepare(input, cancellation) {
      const { signal, dispose } = bridgeCancellation(cancellation);
      try {
        if (closed || preparationStarted)
          throw new Error("API session cannot prepare twice");
        preparationStarted = true;
        if (input.tags.length)
          throw new Error("XHS API topics are unsupported");
        prepared = await prepare(input, signal);
      } finally {
        dispose();
      }
    },
    async submit({ signal: cancellation, beforeCommit }) {
      const { signal, dispose } = bridgeCancellation(cancellation);
      try {
        if (closed || submissionStarted || !prepared)
          throw new Error("API session cannot submit");
        submissionStarted = true; // Poison even if signing/commit fails. No task/session replay.
        checkCancellation(signal);
        await ports.verifyIdentity(signal);
        const send = await ports.signNote(prepared.serializedBody, signal);
        checkCancellation(signal);
        await beforeCommit();
        // Cancellation after a durable commit is conservatively handled as uncertain by publishing.
        checkCancellation(signal);
        const response = await send();
        return parseXhsNoteResponse(response.status, response.body);
      } finally {
        dispose();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      prepared = undefined;
      await ports.close();
    },
  };
}
function bridgeCancellation(source: PublishAbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => source.removeEventListener("abort", abort),
  };
}
