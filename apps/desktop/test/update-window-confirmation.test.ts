import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(async () => undefined) }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn() };
    once = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    isDestroyed = () => false;
    loadFile = mocks.load;
    loadURL = mocks.load;
  },
}));
import { ElectronMainWindow } from "../src/main/shell/window/electron-main-window.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("confirms startup only after the new main window loads", async () => {
  let finish!: () => void;
  mocks.load.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const confirmed = vi.fn();
  new ElectronMainWindow(undefined, confirmed).open();
  expect(confirmed).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(confirmed).toHaveBeenCalledOnce());
});
it("keeps the update unconfirmed when renderer loading fails", async () => {
  mocks.load.mockRejectedValueOnce(new Error("renderer unavailable"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const confirmed = vi.fn(),
    failed = vi.fn();
  new ElectronMainWindow(failed, confirmed).open();
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
  expect(confirmed).not.toHaveBeenCalled();
});
