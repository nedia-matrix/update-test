import { expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Function) =>
      handlers.set(channel, handler),
  },
}));
import { registerPreferencesIpc } from "../src/main/preferences/register-preferences-ipc.js";
import { ipcChannels } from "../src/bridge/channels.js";
import type { PreferencesStore } from "../src/main/preferences/preferences-store.js";

it("persists before applying the source, and rejects busy or failed writes without switching", () => {
  const update = vi.fn(() => ({
    schemaVersion: 1,
    appearance: { theme: "system" },
    updates: { sourceUrl: null },
  }));
  const hooks = { assertIdle: vi.fn(), changed: vi.fn() };
  registerPreferencesIpc(
    { update, get: vi.fn() } as unknown as PreferencesStore,
    hooks,
  );
  const handler = handlers.get(ipcChannels.updatePreferences)!;
  handler(null, { updates: { sourceUrl: null } });
  expect(update.mock.invocationCallOrder[0]).toBeLessThan(
    hooks.changed.mock.invocationCallOrder[0]!,
  );
  hooks.assertIdle.mockImplementationOnce(() => {
    throw new Error("busy");
  });
  expect(() => handler(null, { updates: { sourceUrl: null } })).toThrow("busy");
  expect(update).toHaveBeenCalledTimes(1);
  update.mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  expect(() => handler(null, { updates: { sourceUrl: null } })).toThrow(
    "disk full",
  );
  expect(hooks.changed).toHaveBeenCalledTimes(1);
  handler(null, { appearance: { theme: "dark" } });
  expect(hooks.changed).toHaveBeenCalledTimes(1);
});
