import type { PlatformExecutionHost } from "@nedia-matrix/platform-sdk";
import {
  xhsSigningAssets,
  readXhsSignature,
  xhsNoteEndpoint,
  xhsIdentityEndpoint,
  isXhsSignedEndpoint,
} from "../signed-api/index.js";

/** Private per-session transport. Never accepts arbitrary platform or upload URLs. */
export async function openXhsSignedTransport(
  host: PlatformExecutionHost,
  assertOwnership: () => void,
  options: { pinSession?: boolean } = {},
) {
  assertOwnership();
  const signer = await host.openScript({
    assets: xhsSigningAssets,
    functionName: "__xhsSign",
    requiredFunctions: ["mnsv2", "__xhsSign"],
    writableCookie: { name: "a1", argumentIndex: 2 },
  });
  const identityUrl = xhsIdentityEndpoint;
  let pinnedIdentity: string | undefined;
  async function binding(url: string) {
    const cookies = await host.cookies(url);
    const a1 = cookies.filter((c) => c.name === "a1");
    if (a1.length !== 1 || !a1[0]!.value || /[;\s]/.test(a1[0]!.value))
      throw new Error("XHS Cookie binding invalid");
    return {
      a1: a1[0]!.value,
      snapshot: JSON.stringify(
        cookies
          .map(({ name, domain, path, value }) => ({
            name,
            domain,
            path,
            value,
          }))
          .sort((a, b) =>
            `${a.domain}/${a.path}/${a.name}`.localeCompare(
              `${b.domain}/${b.path}/${b.name}`,
            ),
          ),
      ),
    };
  }
  async function sign(url: string, body: string, signal?: AbortSignal) {
    if (!isXhsSignedEndpoint(url))
      throw new Error("Unsupported XHS API endpoint");
    assertOwnership();
    signal?.throwIfAborted();
    const before = await binding(url);
    const identity = await binding(identityUrl);
    if (options.pinSession) {
      pinnedIdentity ??= identity.snapshot;
      if (pinnedIdentity !== identity.snapshot)
        throw new Error("XHS session changed during sync");
    }
    if (before.a1 !== identity.a1)
      throw new Error("XHS cross-origin account binding mismatch");
    const address = new URL(url);
    const headers = readXhsSignature(
      await signer.invoke([address.pathname + address.search, body, before.a1]),
    );
    let used = false;
    return async () => {
      if (used) throw new Error("XHS API signed request already consumed");
      used = true;
      signal?.throwIfAborted();
      assertOwnership();
      if (
        before.snapshot !== (await binding(url)).snapshot ||
        identity.snapshot !== (await binding(identityUrl)).snapshot
      )
        throw new Error("XHS session changed during signing");
      try {
        return await host.requestJson({
          url,
          method: url === xhsNoteEndpoint ? "POST" : "GET",
          headers: {
            Accept: "application/json",
            Origin: "https://creator.xiaohongshu.com",
            Referer: "https://creator.xiaohongshu.com/",
            ...headers,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
          timeoutMs: url === xhsNoteEndpoint ? 30_000 : 15_000,
        });
      } catch {
        throw new Error("XHS API request result unavailable");
      }
    };
  }
  return { sign, close: () => signer.close() };
}
