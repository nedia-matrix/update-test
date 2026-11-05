import { playwrightRuntimeVersion } from "@nedia-matrix/automation-playwright/runtime-support";
import { metadataSchemaVersion } from "../persistence/schema-version.js";
import { pluginProtocolVersions } from "../plugins/plugin-protocol.mjs";

export const runtimeCompatibility = Object.freeze({
  schemaVersion: 1,
  engineProtocol: 1,
  browserAutomation: {
    playwrightVersion: playwrightRuntimeVersion,
    profileProtocol: 1,
  },
  metadataSchema: {
    minimum: 0,
    maximum: metadataSchemaVersion,
    target: metadataSchemaVersion,
  },
  pluginProtocol: pluginProtocolVersions.protocol,
  pluginSdk: pluginProtocolVersions.sdk,
  automationProtocol: pluginProtocolVersions.automation,
  capabilities: [
    "exclusive-runtime-v1",
    "shutdown-drain-v1",
    "profile-version-floor-v1",
    "profile-singleton-guard-v1",
    "publication-recovery-v1",
    "local-runtime-idempotency-v1",
  ] as readonly string[],
});
