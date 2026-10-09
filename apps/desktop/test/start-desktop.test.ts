import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  openMainWindow: vi.fn(),
  exit: vi.fn(),
  showErrorBox: vi.fn(),
  construct: vi.fn(),
  flushStartupFailureDiagnostics: vi.fn(async () => undefined),
  preferencesIpc: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => "/nonexistent-matrix-startup-test",
    exit: mocks.exit,
  },
  dialog: { showErrorBox: mocks.showErrorBox },
}));
vi.mock("../src/main/preferences/register-preferences-ipc.js", () => ({
  registerPreferencesIpc: mocks.preferencesIpc,
}));

vi.mock("../src/main/bootstrap/desktop-runtime.js", () => ({
  flushStartupFailureDiagnostics: mocks.flushStartupFailureDiagnostics,
  DesktopRuntime: class {
    constructor(...args: unknown[]) {
      mocks.construct(...args);
    }
    start = mocks.start;
    openMainWindow = mocks.openMainWindow;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("starts the default runtime without a storage selector", async () => {
  await import("../src/main/bootstrap/start-desktop.js");
  await vi.waitFor(() => expect(mocks.openMainWindow).toHaveBeenCalledOnce());
  expect(mocks.construct).toHaveBeenCalledWith();
  expect(mocks.preferencesIpc).toHaveBeenCalledOnce();
  expect(mocks.preferencesIpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.construct.mock.invocationCallOrder[0]!,
  );
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.exit).not.toHaveBeenCalled();
});

it("reports database construction failure before starting business services", async () => {
  let finishFlush: (() => void) | undefined;
  mocks.flushStartupFailureDiagnostics.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      }),
  );
  mocks.construct.mockImplementation(() => {
    throw new Error("invalid metadata");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../src/main/bootstrap/start-desktop.js");
  await vi.waitFor(() =>
    expect(mocks.flushStartupFailureDiagnostics).toHaveBeenCalledOnce(),
  );
  expect(mocks.exit).not.toHaveBeenCalled();
  finishFlush?.();
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.openMainWindow).not.toHaveBeenCalled();
  expect(mocks.showErrorBox).toHaveBeenCalledOnce();
  expect(mocks.preferencesIpc).toHaveBeenCalledOnce();
  expect(mocks.flushStartupFailureDiagnostics).toHaveBeenCalledOnce();
});

it("shows a safe startup error and exits without opening the main window", async () => {
  mocks.start.mockImplementation(() => {
    throw new Error("sensitive local path and publication content");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../src/main/bootstrap/start-desktop.js");
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(mocks.openMainWindow).not.toHaveBeenCalled();
  expect(mocks.showErrorBox).toHaveBeenCalledWith(
    "本地数据恢复失败",
    expect.stringContaining("重新启动以重试"),
  );
  expect(log).toHaveBeenCalledWith("Failed to initialize Electron", "Error");
  expect(mocks.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.exit.mock.invocationCallOrder[0]!,
  );
});
