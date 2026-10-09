import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Locator, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { PlaywrightAutomationDriver } from "../src/index.js";

function contentEditablePage(text = "喵～") {
  const fill = vi.fn(async () => undefined);
  const range = {
    selectNodeContents: vi.fn(),
    collapse: vi.fn(),
  };
  const selection = {
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  const ownerDocument = {
    defaultView: {
      getComputedStyle: () => ({
        borderLeftWidth: "0px",
        borderTopWidth: "0px",
      }),
    },
    activeElement: null as unknown,
    getSelection: () => selection,
    createRange: () => range,
  };
  const element = {
    ownerDocument,
    innerText: text,
    textContent: "喵～#添加话题 @好友",
    getAttribute: (name: string) =>
      name === "contenteditable" ? "true" : null,
  };
  const blur = vi.fn(async () => {
    ownerDocument.activeElement = null;
  });
  const focus = vi.fn(async () => {
    ownerDocument.activeElement = element;
  });
  const press = vi.fn(async () => undefined);
  const click = vi.fn(async () => undefined);
  const pressSequentially = vi.fn(
    async (_text: string, _options?: { delay: number; timeout?: number }) =>
      undefined,
  );
  const dispatchEvent = vi.fn(async () => undefined);
  const insertText = vi.fn(async () => undefined);
  const locator = {
    count: async () => 1,
    nth: () => locator,
    isVisible: async () => true,
    isEnabled: async () => true,
    isEditable: async () => true,
    evaluate: async (
      callback: (target: typeof element) => unknown,
      argument?: unknown,
    ) => (argument ? true : callback(element)),
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 10, width: 200, height: 80 }),
    fill,
    blur,
    focus,
    press,
    click: async (options?: { trial?: boolean }) => {
      if (!options?.trial) await click();
    },
    pressSequentially,
    dispatchEvent,
    textContent: async () => "喵～#添加话题 @好友",
  } as unknown as Locator;
  const context = {};
  const page = {
    context: () => context,
    once: vi.fn(),
    isClosed: () => false,
    mouse: { move: vi.fn(async () => undefined) },
    evaluate: vi.fn(async () => ({ width: 1366, height: 768 })),
    keyboard: { insertText },
    getByTestId: () => locator,
    evaluateHandle: vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
    })),
  } as unknown as Page;
  return {
    page,
    fill,
    blur,
    focus,
    press,
    click,
    pressSequentially,
    dispatchEvent,
    insertText,
    range,
    selection,
  };
}

describe("Playwright form filling", () => {
  it("fills inline topic separators as literal text without committing a topic", async () => {
    vi.useFakeTimers();
    try {
      const value = "正文 #开学第一课  #早八人";
      const { page, press, pressSequentially, insertText } =
        contentEditablePage(value);
      const driver = new PlaywrightAutomationDriver(
        page,
        { allowedHostSuffixes: ["example.test"] } as never,
        "/tmp/evidence",
      );
      const target = (
        await driver.query({ kind: "test-id", value: "body" })
      )[0]!;
      const filling = driver.fill(target, value);
      await vi.runAllTimersAsync();
      await filling;
      expect(press.mock.calls).toEqual([["ControlOrMeta+A"], ["Backspace"]]);
      expect(
        pressSequentially.mock.calls
          .map(([text]) => text)
          .join(" ")
          .replaceAll(" ", ""),
      ).toBe(value.replaceAll(" ", ""));
      expect(insertText.mock.calls).toEqual([[" "], [" "], [" "]]);
      expect(pressSequentially.mock.invocationCallOrder[0]).toBeLessThan(
        insertText.mock.invocationCallOrder[0]!,
      );
      expect(insertText.mock.invocationCallOrder[2]).toBeLessThan(
        pressSequentially.mock.invocationCallOrder.at(-1)!,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects missing text after literal input", async () => {
    vi.useFakeTimers();
    try {
      const { page } = contentEditablePage("#开学第一课#早八人");
      const driver = new PlaywrightAutomationDriver(
        page,
        { allowedHostSuffixes: ["example.test"] } as never,
        "/tmp/evidence",
      );
      const target = (
        await driver.query({ kind: "test-id", value: "body" })
      )[0]!;
      const filling = expect(
        driver.fill(target, "#开学第一课 #早八人"),
      ).rejects.toThrow("filled_value_mismatch");
      await vi.runAllTimersAsync();
      await filling;
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["typeText", "pressKey"] as const)(
    "settles focus before %s writes into existing text",
    async (action) => {
      vi.useFakeTimers();
      try {
        const { page, press, pressSequentially } = contentEditablePage();
        const driver = new PlaywrightAutomationDriver(
          page,
          { allowedHostSuffixes: ["example.test"] } as never,
          "/tmp/evidence",
        );
        const target = (
          await driver.query({ kind: "test-id", value: "body" })
        )[0]!;
        const writing =
          action === "typeText"
            ? driver.typeText(target, "#旅行")
            : driver.pressKey(target, "Space");
        await vi.advanceTimersByTimeAsync(99);
        expect(press).not.toHaveBeenCalled();
        expect(pressSequentially).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await vi.runAllTimersAsync();
        await writing;
        expect(
          action === "typeText" ? pressSequentially : press,
        ).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("replaces through keyboard operations and budgets long input time", async () => {
    vi.useFakeTimers();
    try {
      const { page, fill, click, press, pressSequentially } =
        contentEditablePage();
      const driver = new PlaywrightAutomationDriver(
        page,
        { allowedHostSuffixes: ["example.test"] } as never,
        "/tmp/evidence",
      );
      const target = (
        await driver.query({ kind: "test-id", value: "body" })
      )[0]!;
      const filling = driver.fill(target, "喵～");
      await vi.advanceTimersByTimeAsync(99);
      expect(press).not.toHaveBeenCalled();
      expect(pressSequentially).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await filling;
      expect(fill).not.toHaveBeenCalled();
      expect(click).toHaveBeenCalledOnce();
      expect(press.mock.calls).toEqual([["ControlOrMeta+A"], ["Backspace"]]);
      expect(pressSequentially.mock.calls.map(([text]) => text)).toEqual([
        "喵",
        "～",
      ]);
      expect(pressSequentially.mock.calls[0]![1]!.timeout).toBeGreaterThan(
        30_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("validates a contenteditable using visible editor text", async () => {
    vi.useFakeTimers();
    try {
      const { page, fill, blur } = contentEditablePage();
      const driver = new PlaywrightAutomationDriver(
        page,
        { allowedHostSuffixes: ["example.test"] } as never,
        "/tmp/evidence",
      );
      const target = (
        await driver.query({ kind: "test-id", value: "body" })
      )[0];
      expect(target).toBeDefined();

      const filling = driver.fill(target!, "喵～");
      await vi.runAllTimersAsync();
      await filling;

      expect(fill).not.toHaveBeenCalled();
      expect(blur).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops local image files through a browser DataTransfer", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "matrix-drop-"));
    try {
      const imagePath = join(temporaryDirectory, "image.png");
      await writeFile(imagePath, Buffer.from([1, 2, 3]));
      const { page, dispatchEvent } = contentEditablePage();
      const driver = new PlaywrightAutomationDriver(
        page,
        { allowedHostSuffixes: ["example.test"] } as never,
        "/tmp/evidence",
      );
      const target = (
        await driver.query({ kind: "test-id", value: "drop" })
      )[0];
      expect(target).toBeDefined();

      await driver.dropFiles(target!, [imagePath]);

      expect(dispatchEvent).toHaveBeenNthCalledWith(
        1,
        "dragover",
        expect.objectContaining({ dataTransfer: expect.anything() }),
      );
      expect(dispatchEvent).toHaveBeenNthCalledWith(
        2,
        "drop",
        expect.objectContaining({ dataTransfer: expect.anything() }),
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("types and commits a native topic through keyboard events", async () => {
    const { page, focus, press, pressSequentially, range, selection } =
      contentEditablePage();
    const driver = new PlaywrightAutomationDriver(
      page,
      { allowedHostSuffixes: ["example.test"] } as never,
      "/tmp/evidence",
    );
    const target = (await driver.query({ kind: "test-id", value: "body" }))[0];
    expect(target).toBeDefined();

    await driver.typeText(target!, "#旅行", 80);
    await driver.pressKey(target!, "Enter");

    expect(focus).toHaveBeenCalledOnce();
    expect(range.collapse).toHaveBeenCalledWith(false);
    expect(selection.addRange).toHaveBeenCalledWith(range);
    expect(pressSequentially.mock.calls.map(([text]) => text)).toEqual([
      "#",
      "旅",
      "行",
    ]);
    expect(pressSequentially.mock.calls[0]![1]!.delay).toBe(0);
    expect(press).toHaveBeenCalledWith("Enter");
  });
});
