import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightAutomationDriver } from "../src/automation-driver.js";

async function fixture(
  action:
    | "choose"
    | "wrong"
    | "timeout"
    | "close"
    | "fail"
    | "direct"
    | "covered"
    | "trial-fail",
) {
  const context = {};
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    isClosed: () => false,
    mouse: { move: vi.fn(async () => undefined) },
    evaluate: vi.fn(async () => ({ width: 1366, height: 768 })),
  });
  const setFiles = vi.fn();
  const setInputFiles = vi.fn();
  const dispose = vi.fn();
  const element = {};
  const chooser = {
    element: () => (action === "wrong" ? {} : element),
    setFiles,
  };
  const click = vi.fn(async () => {
    if (action === "fail") throw new Error("click_failed");
    if (action === "close") {
      page.emit("close");
      return;
    }
    if (action !== "timeout") page.emit("filechooser", chooser);
  });
  const trialClick = vi.fn(async () => {
    if (action === "covered") {
      const error = new Error("element is covered");
      error.name = "TimeoutError";
      throw error;
    }
    if (action === "trial-fail") throw new Error("page_closed");
  });
  const locator = {
    count: async () => 1,
    nth: () => locator,
    isVisible: async () => true,
    isEnabled: async () => true,
    isEditable: async () => false,
    evaluate: async (
      callback: (a: object, b: object) => unknown,
      selected: object,
    ) => callback(element, selected),
    evaluateHandle: async () => ({
      asElement: () =>
        action === "direct"
          ? null
          : {
              scrollIntoViewIfNeeded: () => trialClick(),
              boundingBox: async () => ({
                x: 10,
                y: 10,
                width: 200,
                height: 80,
              }),
              evaluate: async (_callback: unknown, argument?: unknown) =>
                argument ? true : { x: 0, y: 0 },
              isEnabled: async () => true,
              click: (options: { trial?: boolean }) =>
                options.trial ? trialClick() : click(),
            },
      dispose,
    }),
    click,
    setInputFiles,
  };
  Object.assign(page, { getByTestId: () => locator });
  const driver = new PlaywrightAutomationDriver(
    page as unknown as Page,
    { allowedHostSuffixes: ["localhost"] } as never,
    "/tmp/evidence",
  );
  const target = (await driver.query({ kind: "test-id", value: "file" }))[0]!;
  return { page, driver, target, setFiles, setInputFiles, click, dispose };
}

describe("file chooser upload", () => {
  it("settles the selected input before setting files", async () => {
    vi.useFakeTimers();
    try {
      const { driver, target, setFiles } = await fixture("choose");
      const upload = driver.uploadFiles(target, ["/tmp/a.png"]);
      await vi.advanceTimersByTimeAsync(99);
      expect(setFiles).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await upload;
      expect(setFiles).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("subscribes before clicking and sets multiple files once", async () => {
    const { page, driver, target, setFiles, click } = await fixture("choose");
    await driver.uploadFiles(target, ["/tmp/a.png", "/tmp/b.png"]);
    expect(click).toHaveBeenCalledOnce();
    expect(setFiles).toHaveBeenCalledWith(["/tmp/a.png", "/tmp/b.png"], {
      timeout: 5_000,
    });
    expect(page.listenerCount("filechooser")).toBe(0);
    expect(page.listenerCount("close")).toBe(1);
  });
  it.each([
    ["wrong", "file_chooser_target_mismatch"],
    ["timeout", "file_chooser_timeout"],
    ["close", "file_chooser_cancelled"],
    ["fail", "click_failed"],
  ] as const)(
    "cleans up after %s without fallback or retry",
    async (action, error) => {
      const { page, driver, target, setFiles, setInputFiles, click } =
        await fixture(action);
      await expect(driver.uploadFiles(target, ["/tmp/a.png"])).rejects.toThrow(
        error,
      );
      expect(setFiles).not.toHaveBeenCalled();
      expect(setInputFiles).not.toHaveBeenCalled();
      expect(click).toHaveBeenCalledOnce();
      expect(page.listenerCount("filechooser")).toBe(0);
      expect(page.listenerCount("close")).toBe(action === "close" ? 0 : 1);
    },
    10_000,
  );
  it("uses direct upload when no standard visible trigger exists", async () => {
    const { driver, target, setInputFiles, click, dispose } =
      await fixture("direct");
    await driver.uploadFiles(target, ["/tmp/a.png"]);
    expect(setInputFiles).toHaveBeenCalledWith(["/tmp/a.png"]);
    expect(click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("uploads directly when the visible input is covered, without a real click", async () => {
    const { driver, target, setInputFiles, setFiles, click, dispose, page } =
      await fixture("covered");
    await driver.uploadFiles(target, ["/tmp/a.png", "/tmp/b.png"]);
    expect(setInputFiles).toHaveBeenCalledExactlyOnceWith([
      "/tmp/a.png",
      "/tmp/b.png",
    ]);
    expect(setFiles).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(page.listenerCount("filechooser")).toBe(0);
  });
  it("does not hide non-actionability errors from the preflight", async () => {
    const { driver, target, setInputFiles, click, dispose } =
      await fixture("trial-fail");
    await expect(driver.uploadFiles(target, ["/tmp/a.png"])).rejects.toThrow(
      "page_closed",
    );
    expect(setInputFiles).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
