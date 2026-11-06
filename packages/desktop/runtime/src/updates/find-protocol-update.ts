import type { ApplicationRelease } from "./application-update.js";
import { fetchUpdateAsset, readBoundedResponse } from "./update-network.js";
import { verifyUpdateManifest } from "./update-manifest.js";
import type { UpdateSource } from "./update-source.js";

export async function findProtocolUpdate(
  source: Extract<UpdateSource, { kind: "manifest" }>,
  keys: Readonly<Record<string, string>>,
  fetcher?: typeof fetch,
): Promise<ApplicationRelease> {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  const load = async (url: string, limit: number) =>
    readBoundedResponse(
      await fetchUpdateAsset(url, "manifest", signal, fetcher),
      limit,
      signal,
    );
  // A mutable endpoint can straddle two publishes. Retry once, never downgrade verification.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [bytes, signature] = await Promise.all([
      load(source.url, 64 * 1024),
      load(source.signatureUrl, 4 * 1024),
    ]).catch((error) => {
      abort.abort();
      throw error;
    });
    try {
      const manifest = verifyUpdateManifest(bytes, signature, keys, {});
      return { version: manifest.version, manifest };
    } catch (error) {
      if (
        attempt === 1 ||
        !(error instanceof Error) ||
        !error.message.includes("签名验证失败")
      )
        throw error;
    }
  }
  throw new Error("更新清单验证失败");
}
