import { createPublicKey, verify } from "node:crypto";

import { APPLICATION_ID } from "../../bridge/update-source.js";
import { validatePublicUpdateUrl } from "./public-update-fetch.js";

export type UpdateDistribution = "app-zip" | "portable" | "nsis";
export interface UpdateArtifact {
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  distribution: UpdateDistribution;
  assetName: string;
  size: number;
  sha256: string;
  url: string;
}
export interface UpdateManifest {
  version: string;
  appId: string;
  artifacts: UpdateArtifact[];
}

const requiredTargets = new Set([
  "darwin/arm64/app-zip",
  "darwin/x64/app-zip",
  "win32/x64/portable",
  "win32/x64/nsis",
]);

/** Verify the original bytes BEFORE parsing, never a reserialized object. */
export function verifyUpdateManifest(
  bytes: Uint8Array,
  signatureBytes: Uint8Array,
  keys: Readonly<Record<string, string>>,
  expected: {
    version?: string;
  },
): UpdateManifest {
  const signature = JSON.parse(Buffer.from(signatureBytes).toString("utf8"));
  if (
    signature?.algorithm !== "Ed25519" ||
    typeof signature.keyId !== "string" ||
    !Object.hasOwn(keys, signature.keyId) ||
    typeof signature.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature)
  ) {
    throw new Error("更新清单签名或受信密钥无效");
  }
  const key = createPublicKey(keys[signature.keyId]!);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, key, Buffer.from(signature.signature, "base64"))
  ) {
    throw new Error("更新清单签名验证失败");
  }
  const manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    typeof manifest?.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) ||
    !manifest.version
      .split(".")
      .every((part: string) => Number.isSafeInteger(Number(part))) ||
    (expected.version !== undefined && manifest.version !== expected.version) ||
    manifest.appId !== APPLICATION_ID ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== requiredTargets.size
  ) {
    throw new Error("更新清单版本、来源或结构不匹配");
  }
  const targets = new Set<string>();
  const names = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const target = `${artifact?.platform}/${artifact?.arch}/${artifact?.distribution}`;
    if (
      !requiredTargets.has(target) ||
      targets.has(target) ||
      typeof artifact.assetName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(artifact.assetName) ||
      names.has(artifact.assetName) ||
      !artifact.assetName.endsWith(
        artifact.distribution === "app-zip" ? ".zip" : ".exe",
      ) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) {
      throw new Error("更新清单包含非法或重复的载荷");
    }
    targets.add(target);
    names.add(artifact.assetName);
    if (typeof artifact.url !== "string")
      throw new Error("更新清单缺少载荷地址");
    validatePublicUpdateUrl(artifact.url);
  }
  return manifest as UpdateManifest;
}

export function selectUpdateArtifact(
  manifest: UpdateManifest,
  target: { platform: string; arch: string; distribution: string },
): UpdateArtifact | undefined {
  return manifest.artifacts.find(
    (artifact) =>
      artifact.platform === target.platform &&
      artifact.arch === target.arch &&
      artifact.distribution === target.distribution,
  );
}
