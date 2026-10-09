import { afterEach, expect, it, vi } from "vitest";
import { loadPreferences } from "../src/renderer/src/preferences.js";

function setup(legacyTheme: string | null) {
  const getPreferences = vi
    .fn()
    .mockResolvedValue({ schemaVersion: 1, appearance: { theme: "light" } });
  const removeItem = vi.fn();
  vi.stubGlobal("window", { matrix: { getPreferences } });
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => legacyTheme),
    removeItem,
  });
  return { getPreferences, removeItem };
}
afterEach(() => vi.unstubAllGlobals());

it("imports legacy appearance and removes it only after persistence succeeds", async () => {
  const { getPreferences, removeItem } = setup("dark");
  const result = await loadPreferences();
  expect(getPreferences).toHaveBeenCalledWith({
    legacyThemePreference: "dark",
  });
  expect(result).toEqual({
    preferences: { schemaVersion: 1, appearance: { theme: "light" } },
    error: false,
  });
  expect(removeItem).toHaveBeenCalledWith("nedia-matrix.theme");
});

it("retains the legacy theme and reports a failed load for retry", async () => {
  const { getPreferences, removeItem } = setup("dark");
  getPreferences.mockRejectedValue(new Error("disk error"));
  expect(await loadPreferences()).toEqual({
    preferences: {
      schemaVersion: 1,
      appearance: { theme: "dark" },
      updates: { sourceUrl: null },
    },
    error: true,
  });
  expect(removeItem).not.toHaveBeenCalled();
});

it("uses defaults instead of importing an invalid legacy value", async () => {
  const { getPreferences } = setup("invalid");
  await loadPreferences();
  expect(getPreferences).toHaveBeenCalledWith({});
});

it("loads file preferences even when localStorage is unavailable", async () => {
  setup(null);
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  });
  expect((await loadPreferences()).error).toBe(false);
});
