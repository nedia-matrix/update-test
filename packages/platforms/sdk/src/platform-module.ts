import type { SessionDetectionPlan } from "@nedia-matrix/automation-engine";
import { z } from "zod";

import type {
  PublishContentForm,
  PlatformWorkflowFormCapability,
  PlatformPublisherFormCapability,
} from "./publishing.js";
import {
  validateSettingDefinitions,
  platformSettingsDefinitions,
} from "./settings.js";
import { publishConstraintsSchema } from "./publishing.js";
import type { PlatformPublishRuntime } from "./runtime.js";
import type {
  PlatformAccountProfileCapability,
  PlatformContentCapability,
} from "./data.js";

export const platformImplementationStatusSchema = z.enum([
  "route-only",
  "reference-derived",
  "fixture-tested",
  "live-tested",
]);
const duplicateProfileReplacementSchema = z.enum(["enabled", "disabled"]);
export type PlatformImplementationStatus = z.infer<
  typeof platformImplementationStatusSchema
>;

export interface PlatformLoginEntry {
  readonly id: string;
  readonly displayName: string;
  readonly url: string;
}

export interface PlatformBrowserPolicy {
  readonly sessionCapabilities?: {
    readonly isolatedPages: boolean;
    readonly parallelSync: boolean;
    readonly headlessSync: boolean;
    readonly headlessPublish?: boolean;
  };
  readonly startUrl: string;
  readonly allowedHostSuffixes: readonly string[];
}

export interface PlatformAccountsCapability {
  readonly implementationStatus: PlatformImplementationStatus;
  readonly duplicateProfileReplacement: "enabled" | "disabled";
  readonly loginEntries: readonly PlatformLoginEntry[];
  readonly detection: SessionDetectionPlan;
}

interface PlatformPublishingBase {
  readonly implementationStatus: PlatformImplementationStatus;
}
export interface PlatformWorkflowPublishingCapability extends PlatformPublishingBase {
  readonly executionMode?: "workflow";
  readonly forms: Readonly<
    Partial<Record<PublishContentForm, PlatformWorkflowFormCapability>>
  >;
  createResultMonitor: PlatformPublishRuntime["createResultMonitor"];
}
export interface PlatformPublisherCapability extends PlatformPublishingBase {
  readonly executionMode: "publisher";
  readonly forms: Readonly<
    Partial<Record<PublishContentForm, PlatformPublisherFormCapability>>
  >;
}
export type PlatformPublishingCapability =
  PlatformWorkflowPublishingCapability | PlatformPublisherCapability;

export interface PlatformModule {
  readonly settings?: import("./settings.js").PlatformSettingDefinitions;
  readonly iconUrl?: string;
  readonly pluginSource?: import("./plugin.js").PlatformPluginSource;
  readonly id: string;
  readonly displayName: string;
  readonly rulesVersion: string;
  readonly browser: PlatformBrowserPolicy;
  readonly accounts: PlatformAccountsCapability;
  readonly accountProfile?: PlatformAccountProfileCapability;
  readonly content?: PlatformContentCapability;
  readonly publishing?: PlatformPublishingCapability;
}

const urlSchema = z.string().url();
const requiredString = z.string().min(1);

function addressOf(url: string): {
  protocol: "http" | "https";
  hostname: string;
} {
  const match = /^(https?):\/\/([^/:?#]+)(?::\d+)?(?:[/?#]|$)/i.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new TypeError(`Unsupported platform URL: ${url}`);
  }
  return {
    protocol: match[1].toLowerCase() as "http" | "https",
    hostname: match[2].toLowerCase(),
  };
}

export function isAllowedPlatformUrl(
  browser: PlatformBrowserPolicy,
  url: string,
): boolean {
  const { protocol, hostname } = addressOf(url);
  if (
    protocol !== "https" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1"
  ) {
    return false;
  }
  return browser.allowedHostSuffixes.some((suffix) => {
    const normalized = suffix.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function assertAllowedUrl(
  module: PlatformModule,
  path: string,
  url: string,
): void {
  urlSchema.parse(url);
  if (!isAllowedPlatformUrl(module.browser, url)) {
    throw new TypeError(`${path} is outside allowed platform hosts: ${url}`);
  }
}

function workflowUrls(module: PlatformModule): readonly [string, string][] {
  const result: [string, string][] = [];
  if (module.publishing?.executionMode === "publisher") return result;
  for (const [formName, form] of Object.entries(
    module.publishing?.forms ?? {},
  )) {
    if (!form) continue;
    for (const [workflowName, workflow] of Object.entries(form.automation)) {
      if (workflow?.startUrl) {
        result.push([
          `publishing.forms.${formName}.automation.${workflowName}.startUrl`,
          workflow.startUrl,
        ]);
      }
    }
  }
  return result;
}

export function definePlatformModule<T extends PlatformModule>(module: T): T {
  if (module.browser.sessionCapabilities) {
    z.object({
      isolatedPages: z.boolean(),
      parallelSync: z.boolean(),
      headlessSync: z.boolean(),
      headlessPublish: z.boolean().optional(),
    })
      .strict()
      .parse(module.browser.sessionCapabilities);
  }
  requiredString.parse(module.id);
  requiredString.parse(module.displayName);
  requiredString.parse(module.rulesVersion);
  if (module.browser.allowedHostSuffixes.length === 0) {
    throw new TypeError("A platform must allow at least one host suffix");
  }
  for (const suffix of module.browser.allowedHostSuffixes) {
    requiredString.parse(suffix);
  }
  platformImplementationStatusSchema.parse(
    module.accounts.implementationStatus,
  );
  if (module.accountProfile) {
    platformImplementationStatusSchema.parse(
      module.accountProfile.implementationStatus,
    );
  }
  if (module.content) {
    platformImplementationStatusSchema.parse(
      module.content.implementationStatus,
    );
  }
  duplicateProfileReplacementSchema.parse(
    module.accounts.duplicateProfileReplacement,
  );
  if (module.publishing) {
    if (
      module.publishing.executionMode !== undefined &&
      !["workflow", "publisher"].includes(module.publishing.executionMode)
    )
      throw new TypeError("Unsupported publishing execution mode");
    if (
      module.publishing.executionMode === "publisher" &&
      "createResultMonitor" in module.publishing
    )
      throw new TypeError("publisher must not define a browser result monitor");
    platformImplementationStatusSchema.parse(
      module.publishing.implementationStatus,
    );
    if (Object.keys(module.publishing.forms).length === 0) {
      throw new TypeError(
        "Publishing capability must define at least one form",
      );
    }
    for (const form of Object.values(module.publishing.forms)) {
      if (!form) continue;
      publishConstraintsSchema.parse(form.constraints);
      if (module.publishing.executionMode === "publisher") {
        if (
          form.executionMode !== "publisher" ||
          !("adapterId" in form) ||
          typeof form.adapterId !== "string" ||
          !form.adapterId.trim() ||
          "automation" in form
        )
          throw new TypeError(
            "publisher forms require an adapter and cannot contain browser automation",
          );
      } else if (
        (form.executionMode !== undefined &&
          form.executionMode !== "workflow") ||
        "adapterId" in form ||
        !("automation" in form) ||
        !form.automation?.prepare ||
        !form.automation?.submit
      ) {
        throw new TypeError(
          "browser forms require prepare and submit automation",
        );
      }
    }
  }

  if (module.settings !== undefined)
    validateSettingDefinitions(module.settings);
  const settings = platformSettingsDefinitions(module);
  validateSettingDefinitions(settings);
  for (const form of Object.values(module.publishing?.forms ?? {})) {
    if (
      !form ||
      !Array.isArray(form.submissionModes) ||
      !form.submissionModes.length ||
      new Set(form.submissionModes).size !== form.submissionModes.length ||
      form.submissionModes.some(
        (mode: unknown) =>
          typeof mode !== "string" ||
          !["automatic", "manual_confirmation"].includes(mode),
      )
    )
      throw new TypeError("Invalid submission modes");
    const values =
      settings.submissionMode?.options.map((option) => option.value) ?? [];
    if (form.submissionModes.some((mode: string) => !values.includes(mode)))
      throw new TypeError("Submission settings omit a supported form mode");
  }
  if (settings.submissionMode) {
    const modes = new Set(
      Object.values(module.publishing?.forms ?? {}).flatMap(
        (form) => form?.submissionModes ?? [],
      ),
    );
    if (
      settings.submissionMode.options.some(
        (option) =>
          !modes.has(option.value as import("./publishing.js").SubmissionMode),
      )
    )
      throw new TypeError("Submission settings contain an unsupported mode");
  }

  assertAllowedUrl(module, "browser.startUrl", module.browser.startUrl);
  const loginEntryIds = new Set<string>();
  for (const entry of module.accounts.loginEntries) {
    requiredString.parse(entry.id);
    requiredString.parse(entry.displayName);
    if (loginEntryIds.has(entry.id)) {
      throw new TypeError(`Duplicate login entry: ${entry.id}`);
    }
    loginEntryIds.add(entry.id);
    assertAllowedUrl(
      module,
      `accounts.loginEntries.${entry.id}.url`,
      entry.url,
    );
  }
  for (const [index, probe] of module.accounts.detection.probes.entries()) {
    assertAllowedUrl(
      module,
      `accounts.detection.probes.${index}.source.url`,
      probe.source.url,
    );
  }
  for (const [path, url] of workflowUrls(module)) {
    assertAllowedUrl(module, path, url);
  }
  return module;
}
