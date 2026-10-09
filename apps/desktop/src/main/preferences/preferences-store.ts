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
      updates: { sourceUrl: null },
    };
    this.write(preferences);
    return preferences;
  }

  update(request: UpdatePreferencesRequest): DesktopPreferences {
    if (
      !isObject(request) ||
      (request.appearance === undefined && request.updates === undefined) ||
      (request.appearance !== undefined &&
        (!isObject(request.appearance) ||
          !isThemePreference(request.appearance.theme))) ||
      (request.updates !== undefined && !isObject(request.updates))
    ) {
      throw new TypeError("Invalid appearance preference");
    }
    const existing = this.read();
    const sourceUrl =
      request.updates === undefined
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
      updates: { ...existing?.updates, sourceUrl },
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
    }
    return value as PreferencesDocument;
  }

  private view(document: DesktopPreferences): DesktopPreferences {
    return {
      schemaVersion: 1,
      appearance: { theme: document.appearance.theme },
      updates: {
        sourceUrl: this.normalizeSource(document.updates?.sourceUrl ?? null),
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
