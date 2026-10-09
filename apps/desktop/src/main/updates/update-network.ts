import type { ApplicationUpdateSource } from "./application-update.js";
import {
  publicUpdateFetch,
  validatePublicUpdateUrl,
} from "./public-update-fetch.js";

// Fail closed on unknown CDN hosts. Extend only after provider verification.
const hosts = {
  github: new Set([
    "github.com",
    "api.github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
  ]),
};

export function validateUpdateUrl(
  url: string,
  source: ApplicationUpdateSource,
): URL {
  const parsed = validatePublicUpdateUrl(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    (source !== "github" && source !== "manifest") ||
    (source === "github" && !hosts.github.has(parsed.hostname))
  ) {
    throw new Error("更新附件地址不在受信来源范围内，请使用下载页手动下载");
  }
  return parsed;
}

export async function fetchUpdateAsset(
  url: string,
  source: ApplicationUpdateSource,
  signal: AbortSignal,
  fetcher: typeof fetch = publicUpdateFetch,
  headers: Record<string, string> = {
    "User-Agent": "NediaMatrix-update-download",
  },
): Promise<Response> {
  let current = validateUpdateUrl(url, source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(current.href, {
      signal,
      redirect: "manual",
      headers,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("更新附件重定向缺少地址");
      current = validateUpdateUrl(new URL(location, current).href, source);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`更新附件下载失败（HTTP ${response.status}）`);
    }
    return response;
  }
  throw new Error("更新附件重定向次数过多");
}

export async function readBoundedResponse(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!response.body) throw new Error("更新附件没有内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Cancel the body too: receiving headers does not mean a metadata request has completed.
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("更新元数据超过大小限制");
      chunks.push(value);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
