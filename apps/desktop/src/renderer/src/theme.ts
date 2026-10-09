import type { ThemePreference } from "../../bridge/preferences.js";

export type { ThemePreference } from "../../bridge/preferences.js";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : preference;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}
