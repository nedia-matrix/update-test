import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  isThemePreference,
  isBrowserProvider,
  type DesktopPreferences,
  type GetPreferencesRequest,
  type UpdatePreferencesRequest,
} from "../../bridge/preferences.js";
import { parseUpdateSource } from "../updates/update-source.js";

type PreferencesDocument = Record<string, unknown> & DesktopPreferences;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PreferencesStore {
  private readonly filePath: string;

  constructor(userDataDirectory: string) {
    this.filePath = join(userDataDirectory, "preferences.json");
  }

  get(request: GetPreferencesRequest = {}): DesktopPreferences {
    if (
      request.legacyThemePreference !== undefined &&
      !isThemePreference(request.legacyThemePreference)
    ) {
      throw new TypeError("Invalid legacy theme preference");
    }
    const existing = this.read();
    if (existing) return this.view(existing);
    const preferences: DesktopPreferences = {
      schemaVersion: 1,
      appearance: { theme: request.legacyThemePreference ?? "system" },
      updates: { sourceUrl: null, includePlugins: true },
      browser: { defaultProvider: "system" },
    };
    this.write(preferences);
    return preferences;
  }

  update(request: UpdatePreferencesRequest): DesktopPreferences {
    if (
      !isObject(request) ||
      (request.appearance === undefined &&
        request.updates === undefined &&
        request.browser === undefined) ||
      (request.appearance !== undefined &&
        (!isObject(request.appearance) ||
          !isThemePreference(request.appearance.theme))) ||
      (request.updates !== undefined &&
        (!isObject(request.updates) ||
          (request.updates.includePlugins !== undefined &&
            typeof request.updates.includePlugins !== "boolean") ||
          (request.updates.sourceUrl === undefined &&
            request.updates.includePlugins === undefined))) ||
      (request.browser !== undefined &&
        (!isObject(request.browser) ||
          (request.browser.defaultProvider === undefined &&
            request.browser.onboardingDismissed === undefined) ||
          (request.browser.defaultProvider !== undefined &&
            !isBrowserProvider(request.browser.defaultProvider)) ||
          (request.browser.onboardingDismissed !== undefined &&
            typeof request.browser.onboardingDismissed !== "boolean")))
    ) {
      throw new TypeError("Invalid appearance preference");
    }
    const existing = this.read();
    const sourceUrl =
      request.updates?.sourceUrl === undefined
        ? (existing?.updates?.sourceUrl ?? null)
        : this.normalizeSource(request.updates.sourceUrl);
    const preferences: PreferencesDocument = {
      ...existing,
      schemaVersion: 1,
      appearance: {
        ...existing?.appearance,
        theme: isThemePreference(request.appearance?.theme)
          ? request.appearance.theme
          : existing
            ? this.view(existing).appearance.theme
            : "system",
      },
      updates: {
        ...existing?.updates,
        sourceUrl,
        includePlugins:
          typeof request.updates?.includePlugins === "boolean"
            ? request.updates.includePlugins
            : (existing?.updates?.includePlugins ?? true),
      },
      browser: {
        ...existing?.browser,
        ...(typeof request.browser?.onboardingDismissed === "boolean"
          ? { onboardingDismissed: request.browser.onboardingDismissed }
          : {}),
        defaultProvider: isBrowserProvider(request.browser?.defaultProvider)
          ? request.browser.defaultProvider
          : (existing?.browser?.defaultProvider ?? "system"),
      },
    };
    this.write(preferences);
    return this.view(preferences);
  }

  private read(): PreferencesDocument | null {
    let source: string;
    try {
      source = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value: unknown = JSON.parse(source);
    if (
      !isObject(value) ||
      value.schemaVersion !== 1 ||
      !isObject(value.appearance) ||
      !isThemePreference(value.appearance.theme)
    ) {
      throw new TypeError("Invalid preferences file");
    }
    if (value.updates !== undefined) {
      if (!isObject(value.updates))
        throw new TypeError("Invalid update preferences");
      this.normalizeSource(value.updates.sourceUrl);
      if (
        value.updates.includePlugins !== undefined &&
        typeof value.updates.includePlugins !== "boolean"
      )
        throw new TypeError("Invalid plugin update preference");
    }
    if (
      value.browser !== undefined &&
      (!isObject(value.browser) ||
        !isBrowserProvider(value.browser.defaultProvider) ||
        (value.browser.onboardingDismissed !== undefined &&
          typeof value.browser.onboardingDismissed !== "boolean"))
    )
      throw new TypeError("Invalid browser preferences");
    return value as PreferencesDocument;
  }

  private view(document: DesktopPreferences): DesktopPreferences {
    return {
      schemaVersion: 1,
      appearance: { theme: document.appearance.theme },
      browser: {
        defaultProvider: document.browser?.defaultProvider ?? "system",
        ...(document.browser?.onboardingDismissed !== undefined
          ? { onboardingDismissed: document.browser.onboardingDismissed }
          : {}),
      },
      updates: {
        sourceUrl: this.normalizeSource(document.updates?.sourceUrl ?? null),
        includePlugins: document.updates?.includePlugins ?? true,
      },
    };
  }

  private normalizeSource(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string")
      throw new TypeError("更新源必须为有效地址或默认值");
    return parseUpdateSource(value).url;
  }

  private write(preferences: DesktopPreferences): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(preferences, null, 2)}\n`,
        { flag: "wx" },
      );
      renameSync(temporaryPath, this.filePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
