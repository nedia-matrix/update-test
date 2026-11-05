import type { PlatformModule } from "./platform-module.js";
import type { SubmissionMode } from "./publishing.js";

export type PlatformSettings = Readonly<Record<string, string>>;
export interface PlatformSelectSetting {
  readonly type: "select";
  readonly label: string;
  readonly description?: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly default: string;
}
export type PlatformSettingDefinitions = Readonly<
  Record<string, PlatformSelectSetting>
>;

/** Standard submission semantics are shared with the host; additional enums belong to the plugin. */
export function platformSettingsDefinitions(
  platform: Pick<PlatformModule, "settings" | "publishing">,
): PlatformSettingDefinitions {
  const definitions = { ...platform.settings };
  const modes = [
    ...new Set(
      Object.values(platform.publishing?.forms ?? {}).flatMap(
        (form) => form?.submissionModes ?? [],
      ),
    ),
  ];
  if (modes.length && !definitions.submissionMode) {
    definitions.submissionMode = {
      type: "select",
      label: "发布提交方式",
      options: modes.map((value) => ({
        value,
        label: value === "automatic" ? "自动提交" : "人工确认",
      })),
      default: modes.includes("manual_confirmation")
        ? "manual_confirmation"
        : modes[0]!,
    };
  }
  return definitions;
}

export function validateSettingDefinitions(
  definitions: PlatformSettingDefinitions,
): void {
  if (
    !definitions ||
    typeof definitions !== "object" ||
    Array.isArray(definitions)
  )
    throw new TypeError("Invalid platform settings definitions");
  for (const [key, setting] of Object.entries(definitions)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !setting ||
      setting.type !== "select" ||
      typeof setting.label !== "string" ||
      !setting.label.trim() ||
      (setting.description !== undefined &&
        (typeof setting.description !== "string" ||
          !setting.description.trim())) ||
      !Array.isArray(setting.options) ||
      !setting.options.length
    )
      throw new TypeError("Invalid platform setting declaration");
    const values = new Set<string>();
    for (const option of setting.options) {
      if (
        !option ||
        typeof option.value !== "string" ||
        !option.value ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        (option.description !== undefined &&
          (typeof option.description !== "string" ||
            !option.description.trim())) ||
        values.has(option.value)
      )
        throw new TypeError("Invalid platform setting option");
      values.add(option.value);
    }
    if (!values.has(setting.default))
      throw new TypeError("Invalid platform setting default");
  }
}

/** Return a detached, immutable value set, rejecting unknown keys and unsupported values. */
export function resolvePlatformSettings(
  platform: Pick<PlatformModule, "settings" | "publishing">,
  values: PlatformSettings = {},
): PlatformSettings {
  const definitions = platformSettingsDefinitions(platform);
  validateSettingDefinitions(definitions);
  assertPlatformSettings(values);
  for (const key of Object.keys(values))
    if (!Object.hasOwn(definitions, key))
      throw new TypeError(`Unknown platform setting: ${key}`);
  const resolved: Record<string, string> = {};
  for (const [key, definition] of Object.entries(definitions)) {
    const value = values[key] ?? definition.default;
    if (!definition.options.some((option) => option.value === value))
      throw new TypeError(`Unsupported platform setting: ${key}`);
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

export function assertPlatformSettings(values: PlatformSettings): void {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.entries(values).some(
      ([key, value]) =>
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        typeof value !== "string",
    )
  )
    throw new TypeError("Invalid platform settings values");
}

export function accountSubmissionMode(account: {
  readonly settings?: PlatformSettings;
}): SubmissionMode {
  const mode = account.settings?.submissionMode ?? "manual_confirmation";
  if (mode !== "automatic" && mode !== "manual_confirmation")
    throw new TypeError("Invalid submission mode setting");
  return mode;
}
