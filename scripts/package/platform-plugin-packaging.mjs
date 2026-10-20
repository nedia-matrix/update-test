import { existsSync } from "node:fs";
import { join } from "node:path";

/** Local packaging can sign with the existing project key; release jobs consume pre-signed packages. */
export function platformPluginBuildEnvironment(
  environment,
  root,
  fileExists = existsSync,
) {
  const inCI =
    environment.CI && environment.CI !== "false" && environment.CI !== "0";
  if (inCI || environment.NEDIA_REQUIRE_UPDATE_KEYS === "1") return null;
  const localPrivateKey = join(root, ".local/release-keys/private.pem");
  const explicitKey =
    environment.NEDIA_UPDATE_PRIVATE_KEY ||
    environment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
  if (!explicitKey && !fileExists(localPrivateKey)) return null;
  return {
    ...environment,
    ...(!explicitKey ? { NEDIA_UPDATE_PRIVATE_KEY_FILE: localPrivateKey } : {}),
    // Packaging always consumes the canonical resource directory, never a development/output override.
    NEDIA_PLUGIN_OUTPUT: join(root, "apps/desktop/resources/plugins"),
  };
}
