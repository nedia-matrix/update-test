import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  preferences: vi.fn(),
  findRelease: vi.fn(),
  send: vi.fn(),
  open: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.3.2",
    getPath: () => "/nonexistent-matrix-updater",
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: mocks.send },
      },
    ],
  },
  shell: { openExternal: mocks.open },
}));
vi.mock("../src/main/preferences/desktop-preferences.js", () => ({
  desktopPreferences: () => ({ get: mocks.preferences }),
}));
vi.mock(
  "../src/main/updates/application-update.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    findLatestRelease: mocks.findRelease,
  }),
);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.preferences.mockReturnValue({
    schemaVersion: 1,
    appearance: { theme: "system" },
    updates: { sourceUrl: null },
  });
  mocks.findRelease.mockResolvedValue({ version: "0.4.0" });
});
afterEach(() => vi.unstubAllGlobals());

it("switches the shared preference source and keeps event revisions monotonic across controllers", async () => {
  const updater =
    await import("../src/main/updates/electron-application-update.js");
  await updater.checkForApplicationUpdateNow();
  expect(mocks.findRelease).toHaveBeenLastCalledWith(
    undefined,
    "github",
    "nedia-matrix/desktop",
  );
  const revision = updater.getApplicationUpdateState().revision;
  mocks.preferences.mockReturnValue({
    updates: { sourceUrl: "https://github.com/another-owner/desktop" },
  });
  updater.updateSourceChanged();
  await updater.checkForApplicationUpdateNow();
  expect(mocks.findRelease).toHaveBeenLastCalledWith(
    undefined,
    "github",
    "another-owner/desktop",
  );
  expect(updater.getApplicationUpdateState().revision).toBeGreaterThan(
    revision,
  );
  const revisions = mocks.send.mock.calls.map(([, state]) => state.revision);
  expect(
    revisions.every(
      (value, index) => index === 0 || value > revisions[index - 1],
    ),
  ).toBe(true);
  await updater.openApplicationUpdateDownload("0.4.0");
  expect(mocks.open).toHaveBeenCalledWith(
    "https://github.com/another-owner/desktop/releases/tag/v0.4.0",
  );
});

it("does not check a default source when the shared preferences cannot be read", async () => {
  mocks.preferences.mockImplementation(() => {
    throw new Error("corrupted preferences");
  });
  const updater =
    await import("../src/main/updates/electron-application-update.js");
  expect(() => updater.getApplicationUpdateState()).toThrow(
    "corrupted preferences",
  );
  expect(mocks.findRelease).not.toHaveBeenCalled();
});
