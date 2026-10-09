import { beforeEach, describe, expect, it, vi } from "vitest";
const windows = vi.hoisted(() => [] as any[]);
const noticeState = vi.hoisted(() => ({
  failCreate: false,
  failLoad: false,
  fallback: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({
  dialog: { showMessageBox: noticeState.fallback },
  BrowserWindow: class {
    handlers: Record<string, Function> = {};
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: (name: string, callback: Function) => {
        this.handlers[name] = callback;
      },
    };
    loadURL = vi.fn(async () => {
      if (noticeState.failLoad) throw new Error("load failed");
    });
    show = vi.fn();
    close = vi.fn(() => this.handlers.closed?.());
    isDestroyed = () => false;
    on = (name: string, callback: Function) => {
      this.handlers[name] = callback;
    };
    constructor(readonly options: unknown) {
      if (noticeState.failCreate) throw new Error("window creation failed");
      windows.push(this);
    }
  },
}));
import { ElectronAutomationNotices } from "../src/main/shell/notifications/electron-automation-notices.js";
beforeEach(() => {
  windows.length = 0;
  noticeState.failCreate = false;
  noticeState.failLoad = false;
  noticeState.fallback.mockClear();
});
describe("automation notice windows", () => {
  it("shows manual publishing instructions without a close-browser action", async () => {
    const close = vi.fn();
    const sink = new ElectronAutomationNotices(close);
    sink.show({
      kind: "publish.awaiting_confirmation",
      accountId: "a",
      publicationId: "p",
    });
    await vi.waitFor(() => expect(windows[0].show).toHaveBeenCalledOnce());
    const html = decodeURIComponent(windows[0].loadURL.mock.calls[0][0]);
    expect(html).toContain("必须亲自点击");
    expect(html).not.toContain('href="https://notice.invalid/close"');
    windows[0].handlers["will-navigate"](
      { preventDefault: vi.fn() },
      "https://notice.invalid/close",
    );
    expect(close).not.toHaveBeenCalled();
  });
  it.each(["close", "dismiss"])(
    "handles %s without blocking the caller",
    async (action) => {
      const close = vi.fn().mockResolvedValue(undefined);
      new ElectronAutomationNotices(close).show({
        kind: "account.synced",
        accountId: "a",
      });
      await vi.waitFor(() => expect(windows[0].show).toHaveBeenCalledOnce());
      windows[0].handlers["will-navigate"](
        { preventDefault: vi.fn() },
        `https://notice.invalid/${action}`,
      );
      await vi.waitFor(() => expect(windows[0].close).toHaveBeenCalledOnce());
      expect(close).toHaveBeenCalledTimes(action === "close" ? 1 : 0);
    },
  );
  it("replaces the old sync prompt when publishing becomes ready", () => {
    const sink = new ElectronAutomationNotices(vi.fn());
    sink.show({ kind: "account.synced", accountId: "a" });
    sink.show({
      kind: "publish.awaiting_confirmation",
      accountId: "a",
      publicationId: "p",
    });
    expect(windows[0].close).toHaveBeenCalledOnce();
    expect(windows).toHaveLength(2);
  });
  it("reports a packaged-window load failure and shows a dialog fallback", async () => {
    noticeState.failLoad = true;
    const report = vi.fn();
    new ElectronAutomationNotices(vi.fn(), report).show({
      kind: "publish.failed",
      accountId: "a",
      publicationId: "p",
      message: "平台返回 461",
      pageAvailable: true,
    });

    await vi.waitFor(() => expect(noticeState.fallback).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "publish.failed" }),
      "notice.failed",
      expect.any(Error),
    );
    expect(noticeState.fallback).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("461") }),
    );
  });
  it("shows a dialog fallback when a notice window cannot be created", async () => {
    noticeState.failCreate = true;
    const report = vi.fn();
    new ElectronAutomationNotices(vi.fn(), report).show({
      kind: "publish.preparation_failed",
      accountId: "a",
      publicationId: "p",
      message: "内容填充失败",
      pageAvailable: false,
    });

    await vi.waitFor(() => expect(noticeState.fallback).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "publish.preparation_failed" }),
      "notice.failed",
      expect.any(Error),
    );
    expect(noticeState.fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("内容填充失败"),
      }),
    );
  });
});
