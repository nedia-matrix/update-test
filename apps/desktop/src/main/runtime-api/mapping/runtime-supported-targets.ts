import type { PlatformSummary } from "../../../bridge/contracts.js";
import type { LocalRuntimeHandshake } from "../http/runtime-router.js";

export function runtimeSupportedTargets(
  platforms: readonly PlatformSummary[],
): LocalRuntimeHandshake["supportedTargets"] {
  return platforms.flatMap((platform) =>
    platform.publishCapabilities
      .filter((form) => form.submissionModes.includes("manual_confirmation"))
      .map((form) => ({
        platform: platform.id,
        contentForm:
          form.contentForm === "imageText"
            ? ("image_text" as const)
            : ("video" as const),
      })),
  );
}
