import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";

import type {
  AutomationKey,
  AutomationDriver,
  ElementReference,
  EvidenceReference,
  LocatorCandidate,
} from "@nedia-matrix/automation-engine";
import { DiagnosticAttachmentStore } from "@nedia-matrix/diagnostics";
import type { PlatformBrowserPolicy } from "@nedia-matrix/platform-sdk";
import type { ElementHandle, FileChooser, Locator, Page } from "playwright";

import {
  HumanInteractionSession,
  pageInteractionSession,
  sampleTiming,
} from "./human-interaction.js";
import { isAllowedPlatformNavigation } from "./navigation-policy.js";

const MAX_ELEMENT_REFERENCES = 500;
const MAX_QUERY_MATCHES = 100;
const SHADOW_CLICK_MARKER = "data-nedia-shadow-click";
const INPUT_SETTLE_MS = 100;
const FILE_CHOOSER_TIMEOUT_MS = 5_000;

type LocatorRoot = Page | Locator;

interface CdpDomNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
}

function attribute(node: CdpDomNode, name: string): string | null {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1] ?? "";
  }
  return null;
}

function walkDom(
  node: CdpDomNode,
  visitor: (candidate: CdpDomNode) => boolean,
): CdpDomNode | null {
  if (visitor(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const match = walkDom(child, visitor);
    if (match) return match;
  }
  return null;
}

export function findClosedShadowDescendant(
  root: CdpDomNode,
  marker: string,
  descendantTag: string,
  descendantClass: string,
): CdpDomNode | null {
  const host = walkDom(
    root,
    (node) => attribute(node, SHADOW_CLICK_MARKER) === marker,
  );
  if (!host) return null;
  const tag = descendantTag.toUpperCase();
  const matches = (node: CdpDomNode): boolean =>
    node.nodeName === tag &&
    (attribute(node, "class") ?? "").split(/\s+/).includes(descendantClass);
  for (const shadowRoot of host.shadowRoots ?? []) {
    const match = walkDom(shadowRoot, matches);
    if (match) return match;
  }
  return null;
}

function locatorForCandidate(
  root: LocatorRoot,
  candidate: LocatorCandidate,
): Locator {
  switch (candidate.kind) {
    case "test-id":
      return root.getByTestId(candidate.value);
    case "css":
      return root.locator(candidate.selector);
    case "text":
      return root.getByText(candidate.text.value, {
        exact: candidate.text.exact,
      });
    case "label":
      return root.getByLabel(candidate.text.value, {
        exact: candidate.text.exact,
      });
    case "aria": {
      if (candidate.role) {
        const role = candidate.role as Parameters<Page["getByRole"]>[0];
        return root.getByRole(role, {
          ...(candidate.name === undefined
            ? {}
            : { name: candidate.name.value, exact: candidate.name.exact }),
        });
      }
      if (!candidate.name) return root.locator("[aria-label]");
      const operator = candidate.name.exact ? "=" : "*=";
      return root.locator(
        `[aria-label${operator}${JSON.stringify(candidate.name.value)}]`,
      );
    }
  }
}

async function readElementState(
  locator: Locator,
): Promise<ElementReference["state"]> {
  const [visible, enabled, editable] = await Promise.all([
    locator.isVisible().catch(() => false),
    locator.isEnabled().catch(() => false),
    locator.isEditable().catch(() => false),
  ]);
  return { attached: true, visible, enabled, editable };
}

async function focusAtTextEnd(locator: Locator): Promise<void> {
  const alreadyFocused = await locator.evaluate(
    (element) => element.ownerDocument.activeElement === element,
  );
  if (alreadyFocused) return;

  await locator.focus();
  await locator.evaluate((element) => {
    if (element.getAttribute("contenteditable") === "true") {
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }

    const value = Reflect.get(element, "value");
    const setSelectionRange = Reflect.get(element, "setSelectionRange");
    if (typeof value === "string" && typeof setSelectionRange === "function") {
      Reflect.apply(setSelectionRange, element, [value.length, value.length]);
    }
  });
}

function normalizeFilledText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mediaType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function assertAbsoluteFilePaths(filePaths: readonly string[]): void {
  if (
    filePaths.length === 0 ||
    filePaths.some((filePath) => !isAbsolute(filePath))
  ) {
    throw new TypeError("Upload paths must be non-empty absolute paths");
  }
}

export class PlaywrightAutomationDriver implements AutomationDriver {
  private readonly locators = new Map<string, Locator>();

  constructor(
    private readonly page: Page,
    private readonly browser: PlatformBrowserPolicy,
    private readonly evidenceDirectory: string,
    private readonly providedInteraction?: HumanInteractionSession,
  ) {}

  get interaction(): HumanInteractionSession {
    return this.providedInteraction ?? pageInteractionSession(this.page);
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async navigate(url: string): Promise<void> {
    if (!isAllowedPlatformNavigation(url, this.browser)) {
      throw new Error("Navigation target is outside the platform boundary");
    }
    await this.interaction.run(async () => {
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        signal: this.interaction.signal,
      });
      await this.interaction.pause("navigate");
    });
  }

  async wait(milliseconds: number): Promise<void> {
    await this.interaction.wait(milliseconds);
  }

  async query(
    candidate: LocatorCandidate,
  ): Promise<readonly ElementReference[]> {
    const matches = locatorForCandidate(this.page, candidate);
    const count = Math.min(await matches.count(), MAX_QUERY_MATCHES);
    const references: ElementReference[] = [];

    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index);
      const id = randomUUID();
      this.remember(id, locator);
      references.push({ id, state: await readElementState(locator) });
    }
    return references;
  }

  async click(target: ElementReference): Promise<void> {
    await this.interaction.run(() =>
      this.interaction.click(this.locatorFor(target)),
    );
  }

  async clickAtPosition(
    target: ElementReference,
    xRatio: number,
    yRatio: number,
  ): Promise<void> {
    if (
      ![xRatio, yRatio].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )
    ) {
      throw new TypeError("Click ratio must be between zero and one");
    }
    await this.interaction.run(() =>
      this.interaction.click(this.locatorFor(target), { x: xRatio, y: yRatio }),
    );
  }

  async prepareCommit(): Promise<void> {
    await this.interaction.run(() => this.interaction.pause("submit"));
  }

  async clickClosedShadowDescendant(
    target: ElementReference,
    descendantTag: string,
    descendantClass: string,
  ): Promise<void> {
    await this.interaction.run(async () => {
      const locator = this.locatorFor(target);
      const marker = randomUUID();
      await locator.evaluate(
        (element, input) => element.setAttribute(input.name, input.value),
        { name: SHADOW_CLICK_MARKER, value: marker },
      );
      const cdp = await this.page.context().newCDPSession(this.page);
      try {
        const { root } = await cdp.send("DOM.getDocument", {
          depth: -1,
          pierce: true,
        });
        const descendant = findClosedShadowDescendant(
          root as CdpDomNode,
          marker,
          descendantTag,
          descendantClass,
        );
        if (!descendant) throw new Error("closed_shadow_target_not_found");
        const { model } = await cdp.send("DOM.getBoxModel", {
          nodeId: descendant.nodeId,
        });
        const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
        if ([x1, y1, x2, y2, x3, y3, x4, y4].some((value) => value == null)) {
          throw new Error("closed_shadow_target_has_no_box");
        }
        const u = 0.4 + this.interaction.random() * 0.2;
        const v = 0.4 + this.interaction.random() * 0.2;
        const x =
          (1 - u) * (1 - v) * x1! +
          u * (1 - v) * x2! +
          u * v * x3! +
          (1 - u) * v * x4!;
        const y =
          (1 - u) * (1 - v) * y1! +
          u * (1 - v) * y2! +
          u * v * y3! +
          (1 - u) * v * y4!;
        const deadline = Date.now() + 30_000;
        await this.interaction.move({ x, y }, deadline);
        await this.interaction.pause("pointer", deadline);
        const { object } = await cdp.send("DOM.resolveNode", {
          nodeId: descendant.nodeId,
          objectGroup: marker,
        });
        if (!object.objectId) throw new Error("closed_shadow_target_detached");
        const { result } = await cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function(x, y) {
          const rect = this.getBoundingClientRect();
          for (let candidate = this; candidate;) {
            const root = candidate.getRootNode();
            const hit = root.elementFromPoint(x, y);
            if (!hit || !(candidate === hit || candidate.contains(hit))) return false;
            candidate = root.host || null;
          }
          let opacity = 1;
          for (let el = this; el; el = el.parentElement || el.getRootNode().host) {
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility !== "visible") return false;
            opacity *= Number(style.opacity);
          }
          return opacity >= 0.1 && !this.disabled && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        }`,
          arguments: [{ value: x }, { value: y }],
          returnByValue: true,
        });
        if (result.value !== true)
          throw new Error("closed_shadow_target_moved_or_obscured");
        this.interaction.check(deadline);
        await this.page.mouse.click(x, y, {
          delay: sampleTiming("hold", this.interaction.random),
        });
      } finally {
        await cdp
          .send("Runtime.releaseObjectGroup", { objectGroup: marker })
          .catch(() => undefined);
        await cdp.detach().catch(() => undefined);
        await locator
          .evaluate(
            (element, name) => element.removeAttribute(name),
            SHADOW_CLICK_MARKER,
          )
          .catch(() => undefined);
      }
    });
  }

  async fill(target: ElementReference, value: string): Promise<void> {
    await this.interaction.run(async () => {
      const locator = this.locatorFor(target);
      const contentEditable = await locator.evaluate(
        (element) => element.getAttribute("contenteditable") === "true",
      );
      await this.interaction.click(locator);
      await this.interaction.wait(INPUT_SETTLE_MS);
      await locator.press("ControlOrMeta+A");
      await locator.press("Backspace");
      await this.interaction.type(locator, value);
      await this.interaction.wait(contentEditable ? 500 : 50);
      await locator.blur();
      await this.interaction.wait(50);

      let actual: string | null;
      if (contentEditable) {
        actual = await locator.evaluate((element) => {
          const innerText = Reflect.get(element, "innerText");
          if (typeof innerText === "string") return innerText;
          return element.textContent;
        });
      } else {
        actual = await locator.inputValue().catch(() => null);
      }
      if (
        typeof actual !== "string" ||
        normalizeFilledText(actual) !== normalizeFilledText(value)
      ) {
        const actualLength =
          typeof actual === "string" ? normalizeFilledText(actual).length : 0;
        throw new Error(
          `filled_value_mismatch(expected_length=${normalizeFilledText(value).length}, actual_length=${actualLength})`,
        );
      }
    });
  }

  async typeText(
    target: ElementReference,
    value: string,
    delayMs?: number,
  ): Promise<void> {
    await this.interaction.run(async () => {
      const locator = this.locatorFor(target);
      await focusAtTextEnd(locator);
      await this.interaction.wait(INPUT_SETTLE_MS);
      await this.interaction.type(locator, value, delayMs);
    });
  }

  async pressKey(target: ElementReference, key: AutomationKey): Promise<void> {
    await this.interaction.run(async () => {
      const locator = this.locatorFor(target);
      await focusAtTextEnd(locator);
      await this.interaction.wait(INPUT_SETTLE_MS);
      this.interaction.check();
      await locator.press(key);
    });
  }

  async uploadFiles(
    target: ElementReference,
    filePaths: readonly string[],
  ): Promise<void> {
    await this.interaction.run(async () => {
      assertAbsoluteFilePaths(filePaths);
      const input = this.locatorFor(target);
      // Only standard HTML associations are inferred; custom upload buttons are not guessed.
      const handle = await input.evaluateHandle((element) => {
        const fileInput = element as unknown as {
          tagName: string;
          type: string;
          disabled: boolean;
          labels?: ArrayLike<typeof element>;
        };
        if (
          fileInput.tagName !== "INPUT" ||
          fileInput.type !== "file" ||
          fileInput.disabled
        )
          return null;
        return (
          [...Array.from(fileInput.labels ?? []), element].find((candidate) => {
            const style =
              candidate.ownerDocument.defaultView?.getComputedStyle(candidate);
            const rect = candidate.getBoundingClientRect();
            return (
              style &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse" &&
              style.pointerEvents !== "none" &&
              rect.width > 0 &&
              rect.height > 0
            );
          }) ?? null
        );
      });
      try {
        const trigger = handle.asElement();
        // Preflight cannot use trial click: it moves the mouse before our curve.
        // Check the visible standard trigger without sending pointer input.
        let clickable = false;
        if (trigger) {
          try {
            const deadline = Date.now() + FILE_CHOOSER_TIMEOUT_MS;
            await trigger.scrollIntoViewIfNeeded({
              timeout: FILE_CHOOSER_TIMEOUT_MS,
              signal: this.interaction.signal,
            });
            const box = await trigger.boundingBox();
            if (box) {
              await this.interaction.verifyPoint(
                trigger,
                { x: box.x + box.width / 2, y: box.y + box.height / 2 },
                deadline,
              );
              clickable = true;
            }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              (error.name !== "TimeoutError" &&
                error.message !== "click_target_moved_or_obscured")
            )
              throw error;
          }
        }
        if (!trigger || !clickable) {
          await this.interaction.wait(INPUT_SETTLE_MS);
          await input.setInputFiles([...filePaths]);
          return;
        }
        await this.uploadThroughChooser(input, trigger, filePaths);
      } finally {
        await handle.dispose();
      }
    });
  }

  private async uploadThroughChooser(
    input: Locator,
    trigger: ElementHandle,
    filePaths: readonly string[],
  ): Promise<void> {
    let onChooser!: (chooser: FileChooser) => void;
    let onClose!: () => void;
    let cancelWait!: (error: Error) => void;
    let timer!: ReturnType<typeof setTimeout>;
    const chooserPromise = new Promise<FileChooser>((resolve, reject) => {
      cancelWait = reject;
      onChooser = resolve;
      onClose = () => reject(new Error("file_chooser_page_closed"));
      this.page.on("filechooser", onChooser);
      this.page.on("close", onClose);
    });
    const onAbort = () => cancelWait(new Error("file_chooser_cancelled"));
    this.interaction.signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Attach both rejection handlers before clicking; either operation may fail first.
      const [chooser] = await Promise.all([
        chooserPromise,
        this.interaction
          .click(trigger, undefined, Date.now() + FILE_CHOOSER_TIMEOUT_MS)
          .then(() => {
            if (this.interaction.signal.aborted) return;
            // Only time the chooser after the click completes, so a blocked
            // click retains Playwright's actionable diagnostic instead.
            timer = setTimeout(
              () => cancelWait(new Error("file_chooser_timeout")),
              FILE_CHOOSER_TIMEOUT_MS,
            );
          }),
      ]);
      if (
        !(await input.evaluate(
          (element, selected) => element === selected,
          chooser.element(),
        ))
      ) {
        throw new Error("file_chooser_target_mismatch");
      }
      await this.interaction.wait(INPUT_SETTLE_MS);
      await chooser.setFiles([...filePaths], {
        timeout: FILE_CHOOSER_TIMEOUT_MS,
      });
    } finally {
      this.interaction.signal.removeEventListener("abort", onAbort);
      cancelWait(new Error("file_chooser_wait_finished"));
      clearTimeout(timer);
      this.page.off("filechooser", onChooser);
      this.page.off("close", onClose);
    }
  }

  async dropFiles(
    target: ElementReference,
    filePaths: readonly string[],
  ): Promise<void> {
    await this.interaction.run(async () => {
      assertAbsoluteFilePaths(filePaths);
      const payload = await Promise.all(
        filePaths.map(async (filePath) => ({
          name: basename(filePath),
          type: mediaType(filePath),
          base64: (await readFile(filePath)).toString("base64"),
        })),
      );
      const dataTransfer = await this.page.evaluateHandle((files) => {
        const browser = globalThis as unknown as {
          atob(value: string): string;
          DataTransfer: new () => { items: { add(file: unknown): void } };
          File: new (
            parts: readonly unknown[],
            name: string,
            options: { type: string },
          ) => unknown;
        };
        const transfer = new browser.DataTransfer();
        for (const file of files) {
          const bytes = Uint8Array.from(
            browser.atob(file.base64),
            (character) => character.charCodeAt(0),
          );
          transfer.items.add(
            new browser.File([bytes], file.name, { type: file.type }),
          );
        }
        return transfer;
      }, payload);
      try {
        const locator = this.locatorFor(target);
        this.interaction.check();
        await locator.dispatchEvent("dragover", { dataTransfer });
        this.interaction.check();
        await locator.dispatchEvent("drop", { dataTransfer });
      } finally {
        await dataTransfer.dispose();
      }
    });
  }

  async textContent(target: ElementReference): Promise<string | null> {
    return this.locatorFor(target).textContent();
  }

  async attribute(
    target: ElementReference,
    name: string,
  ): Promise<string | null> {
    return this.locatorFor(target).getAttribute(name);
  }

  async captureEvidence(reason: string): Promise<EvidenceReference> {
    const screenshot = await this.page.screenshot({ fullPage: true });
    const metadata = await new DiagnosticAttachmentStore(
      dirname(this.evidenceDirectory),
    ).saveScreenshot({
      traceId: basename(this.evidenceDirectory),
      png: screenshot,
      reasonCode: "workflow_failure",
    });
    return {
      id: metadata.id,
      capturedAt: metadata.capturedAt,
      reason,
      mimeType: metadata.mimeType,
      byteSize: metadata.byteSize,
      width: metadata.width,
      height: metadata.height,
      relativeRef: metadata.relativeRef,
    };
  }

  private locatorFor(reference: ElementReference): Locator {
    const locator = this.locators.get(reference.id);
    if (!locator) throw new Error("page_changed");
    return locator;
  }

  private remember(id: string, locator: Locator): void {
    this.locators.set(id, locator);
    if (this.locators.size <= MAX_ELEMENT_REFERENCES) return;
    const oldestId = this.locators.keys().next().value as string | undefined;
    if (oldestId) this.locators.delete(oldestId);
  }
}
