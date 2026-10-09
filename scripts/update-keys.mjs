import { readFileSync } from "node:fs";

export const publicKeysFile = new URL(
  "../apps/desktop/resources/update-public-keys.json",
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
