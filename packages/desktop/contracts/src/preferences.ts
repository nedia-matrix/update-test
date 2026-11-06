export type ThemePreference = "system" | "light" | "dark";

export type BrowserProvider = "system" | "fingerprint";

export function isBrowserProvider(value: unknown): value is BrowserProvider {
  return value === "system" || value === "fingerprint";
}

export interface DesktopPreferences {
  schemaVersion: 1;
  appearance: { theme: ThemePreference };
  updates: { sourceUrl: string | null; includePlugins: boolean };
  browser: { defaultProvider: BrowserProvider; onboardingDismissed?: boolean };
}

export interface GetPreferencesRequest {
  legacyThemePreference?: ThemePreference;
}

export interface UpdatePreferencesRequest {
  appearance?: { theme: ThemePreference };
  updates?: { sourceUrl?: string | null; includePlugins?: boolean };
  browser?: {
    defaultProvider?: BrowserProvider;
    onboardingDismissed?: boolean;
  };
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
