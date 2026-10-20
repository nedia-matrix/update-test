import { platformSettingsDefinitions } from "@nedia-matrix/platform-sdk";
import type { PlatformModule } from "@nedia-matrix/platform-sdk";

import type { PlatformSummary } from "../../bridge/contracts.js";

export function toPlatformSummary(platform: PlatformModule): PlatformSummary {
  return {
    id: platform.id,
    settings: platformSettingsDefinitions(platform),
    iconUrl: platform.iconUrl,
    displayName: platform.displayName,
    entryUrl: platform.browser.startUrl,
    rulesVersion: platform.rulesVersion,
    implementationStatus:
      platform.publishing?.implementationStatus ??
      platform.accounts.implementationStatus,
    loginEntries: platform.accounts.loginEntries.map((entry) => ({ ...entry })),
    publishCapabilities: Object.entries(
      platform.publishing?.forms ?? {},
    ).flatMap(([contentForm, form]) =>
      form && (contentForm === "video" || contentForm === "imageText")
        ? [
            {
              contentForm,
              submissionModes: [...form.submissionModes],
              constraints: { ...form.constraints },
              ...(form.tagPolicy ? { tagPolicy: { ...form.tagPolicy } } : {}),
              ...(form.descriptionComposition
                ? {
                    descriptionComposition: {
                      parts: [...form.descriptionComposition.parts],
                      separator: form.descriptionComposition.separator,
                    },
                  }
                : {}),
            },
          ]
        : [],
    ),
  };
}
