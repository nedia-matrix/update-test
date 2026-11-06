import type { ThemePreference } from "@nedia-matrix/desktop-contracts/preferences";

export type { ThemePreference } from "@nedia-matrix/desktop-contracts/preferences";
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
