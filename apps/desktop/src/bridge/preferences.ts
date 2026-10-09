export type ThemePreference = "system" | "light" | "dark";

export interface DesktopPreferences {
  schemaVersion: 1;
  appearance: { theme: ThemePreference };
  updates: { sourceUrl: string | null };
}

export interface GetPreferencesRequest {
  legacyThemePreference?: ThemePreference;
}

export interface UpdatePreferencesRequest {
  appearance?: { theme: ThemePreference };
  updates?: { sourceUrl: string | null };
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
