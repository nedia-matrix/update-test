import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

export const publicKeysFile = new URL(
  "../../resources/desktop/update-public-keys.json",
  import.meta.url,
);

/** An explicit JSON override still supports CI and key rotation. Empty CI vars use the repo defaults. */
export function configuredPublicKeys(environment = process.env) {
  if (environment.NEDIA_UPDATE_PUBLIC_KEYS)
    return JSON.parse(environment.NEDIA_UPDATE_PUBLIC_KEYS);
  try {
    return JSON.parse(readFileSync(publicKeysFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/** Public trust only. Use the same validation for both desktop build targets. */
export function validateReleasePublicKeys(value, { required = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "NEDIA_UPDATE_PUBLIC_KEYS must be a JSON object of key IDs and PEM public keys",
    );
  if (required && Object.keys(value).length === 0)
    throw new Error("签名发布构建必须配置 NEDIA_UPDATE_PUBLIC_KEYS");
  if (Object.hasOwn(value, "development-only"))
    throw new Error("发行信任配置不能包含插件开发密钥");
  for (const [id, pem] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
      typeof pem !== "string" ||
      !pem.includes("-----BEGIN PUBLIC KEY-----") ||
      pem.includes("PRIVATE KEY") ||
      createPublicKey(pem).asymmetricKeyType !== "ed25519"
    )
      throw new Error(
        "NEDIA_UPDATE_PUBLIC_KEYS contains an invalid Ed25519 public key",
      );
  }
  return value;
}
