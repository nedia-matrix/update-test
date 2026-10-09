import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PreferencesStore } from "../src/main/preferences/preferences-store.js";
import type { UpdatePreferencesRequest } from "../src/bridge/preferences.js";

let directory: string;
let store: PreferencesStore;
const read = () =>
  JSON.parse(readFileSync(join(directory, "preferences.json"), "utf8"));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "matrix-preferences-"));
  store = new PreferencesStore(directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("creates system appearance defaults in the unified file", () => {
  expect(store.get()).toEqual({
    schemaVersion: 1,
    appearance: { theme: "system" },
    updates: { sourceUrl: null },
  });
  expect(read()).toEqual(store.get());
});

it("imports a legacy theme once and restores the file across restart", () => {
  expect(store.get({ legacyThemePreference: "dark" }).appearance.theme).toBe(
    "dark",
  );
  const restarted = new PreferencesStore(directory);
  expect(
    restarted.get({ legacyThemePreference: "light" }).appearance.theme,
  ).toBe("dark");
  restarted.update({ appearance: { theme: "system" } });
  expect(
    new PreferencesStore(directory).get({ legacyThemePreference: "dark" })
      .appearance.theme,
  ).toBe("system");
});

it("preserves other preference sections and appearance fields when saving", () => {
  writeFileSync(
    join(directory, "preferences.json"),
    JSON.stringify({
      schemaVersion: 1,
      appearance: { theme: "dark", density: "compact" },
      editor: { language: "zh-CN" },
    }),
  );
  store.update({ appearance: { theme: "light" } });
  expect(read()).toEqual({
    schemaVersion: 1,
    appearance: { theme: "light", density: "compact" },
    editor: { language: "zh-CN" },
    updates: { sourceUrl: null },
  });
  expect(readdirSync(directory)).toEqual(["preferences.json"]);
});

it.each([
  "{broken",
  '{"schemaVersion":2,"appearance":{"theme":"dark"}}',
  '{"schemaVersion":1,"appearance":{"theme":"invalid"}}',
])("leaves invalid or unsupported files intact: %s", (source) => {
  writeFileSync(join(directory, "preferences.json"), source);
  expect(() => store.get({ legacyThemePreference: "dark" })).toThrow();
  expect(() => store.update({ appearance: { theme: "light" } })).toThrow();
  expect(readFileSync(join(directory, "preferences.json"), "utf8")).toBe(
    source,
  );
});

it("rejects malformed updates without changing the file", () => {
  store.get();
  for (const request of [
    null,
    {},
    { appearance: null },
    { appearance: { theme: "invalid" } },
  ]) {
    expect(() => store.update(request as UpdatePreferencesRequest)).toThrow(
      TypeError,
    );
  }
  expect(read().appearance.theme).toBe("system");
});

it("patches source and appearance independently and restores the source after restart", () => {
  store.get({ legacyThemePreference: "dark" });
  store.update({
    updates: { sourceUrl: "https://github.com/another-owner/desktop/" },
  });
  expect(new PreferencesStore(directory).get()).toMatchObject({
    appearance: { theme: "dark" },
    updates: { sourceUrl: "https://github.com/another-owner/desktop" },
  });
  store.update({ appearance: { theme: "light" } });
  expect(store.get().updates.sourceUrl).toBe(
    "https://github.com/another-owner/desktop",
  );
  store.update({ updates: { sourceUrl: null } });
  expect(store.get()).toMatchObject({
    appearance: { theme: "light" },
    updates: { sourceUrl: null },
  });
});

it("reads a theme-only v1 file without rewriting it or reimporting localStorage", () => {
  const source = JSON.stringify({
    schemaVersion: 1,
    appearance: { theme: "dark" },
  });
  writeFileSync(join(directory, "preferences.json"), source);
  expect(store.get({ legacyThemePreference: "light" })).toMatchObject({
    appearance: { theme: "dark" },
    updates: { sourceUrl: null },
  });
  expect(readFileSync(join(directory, "preferences.json"), "utf8")).toBe(
    source,
  );
});

it("does not overwrite a corrupted source or silently authorize the default source", () => {
  const source = JSON.stringify({
    schemaVersion: 1,
    appearance: { theme: "dark" },
    updates: { sourceUrl: "https://127.0.0.1/update-manifest.json" },
  });
  writeFileSync(join(directory, "preferences.json"), source);
  expect(() => store.get()).toThrow();
  expect(() => store.update({ appearance: { theme: "light" } })).toThrow();
  expect(readFileSync(join(directory, "preferences.json"), "utf8")).toBe(
    source,
  );
});
