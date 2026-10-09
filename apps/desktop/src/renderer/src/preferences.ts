import {
  isThemePreference,
  type DesktopPreferences,
} from "../../bridge/preferences.js";

const legacyThemeStorageKey = "nedia-matrix.theme";

export async function loadPreferences(): Promise<{
  preferences: DesktopPreferences;
  error: boolean;
}> {
  let legacyTheme: string | null = null;
  try {
    legacyTheme = globalThis.localStorage.getItem(legacyThemeStorageKey);
  } catch {
    // Preferences remain available when Chromium storage cannot be read.
  }
  try {
    const preferences = await window.matrix.getPreferences(
      isThemePreference(legacyTheme)
        ? { legacyThemePreference: legacyTheme }
        : {},
    );
    try {
      globalThis.localStorage.removeItem(legacyThemeStorageKey);
    } catch {
      // The persisted file takes precedence if legacy cleanup cannot complete.
    }
    return { preferences, error: false };
  } catch {
    return {
      preferences: {
        schemaVersion: 1,
        appearance: {
          theme: isThemePreference(legacyTheme) ? legacyTheme : "system",
        },
        updates: { sourceUrl: null },
      },
      error: true,
    };
  }
}
