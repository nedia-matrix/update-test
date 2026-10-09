import { randomUUID } from "node:crypto";
import type { AutomationDriver } from "@nedia-matrix/automation-engine";
import type { Page } from "playwright";
import { PlaywrightAutomationDriver } from "./automation-driver.js";
import { createPlaywrightSessionProbeClient } from "./session-probe-client.js";
import { createPlaywrightPublishObservationSession } from "./publish-observation-session.js";
import type {
  OpenedBrowserContext,
  OpenPersistentBrowserSessionOptions,
} from "./persistent-browser-session.js";

export interface ManagedBrowserPage {
  readonly id: string;
  readonly profileId: string;
  readonly purpose: "user" | "sync" | "publish";
  readonly publicationId?: string;
  readonly owner: "AUTOMATION" | "HUMAN";
  readonly page: Page;
  readonly driver: AutomationDriver;
  readonly sessionProbeClient: ReturnType<
    typeof createPlaywrightSessionProbeClient
  >;
  readonly observationSession?: Awaited<
    ReturnType<typeof createPlaywrightPublishObservationSession>
  >;
  focus(): Promise<void>;
  handoff(): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
  closeByUser(): Promise<void>;
  dispose(): Promise<void>;
}

/** Control handles are revoked before draining in-flight operations at handoff. */
export async function createManagedBrowserPage(
  browser: OpenedBrowserContext,
  options: OpenPersistentBrowserSessionOptions,
  purpose: ManagedBrowserPage["purpose"],
  publicationId?: string,
  existingPage?: Page,
): Promise<ManagedBrowserPage> {
  const page = existingPage ?? (await browser.context.newPage());
  const probe = createPlaywrightSessionProbeClient(
    browser.context,
    page,
    options.browser,
    options.sessionDetection,
  );
  let observation: ManagedBrowserPage["observationSession"];
  try {
    if (purpose === "publish")
      observation = await createPlaywrightPublishObservationSession(
        browser.context,
        page,
      );
  } catch (error) {
    probe.dispose();
    await page.close();
    throw error;
  }
  let owner: ManagedBrowserPage["owner"] = "AUTOMATION";
  let revoked = false;
  let disposed: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const raw = new PlaywrightAutomationDriver(
    page,
    options.browser,
    options.evidenceDirectory,
  );
  const driver: AutomationDriver = new Proxy(raw, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        const observing = [
          "currentUrl",
          "query",
          "textContent",
          "attribute",
          "captureEvidence",
          "wait",
        ].includes(String(key));
        if ((!observing && revoked) || page.isClosed())
          return Promise.reject(new Error("页面控制权已移交或页面已关闭"));
        const result = Promise.resolve(Reflect.apply(method, target, args));
        active.add(result);
        void result.then(
          () => active.delete(result),
          () => active.delete(result),
        );
        return result;
      };
    },
  });
  const dispose = () =>
    (disposed ??= (async () => {
      revoked = true;
      raw.interaction.stop();
      probe.dispose();
      await observation?.dispose().catch(() => undefined);
    })());
  const managed: ManagedBrowserPage = {
    id: randomUUID(),
    profileId: options.profileId,
    purpose,
    ...(publicationId ? { publicationId } : {}),
    get owner() {
      return owner;
    },
    page,
    driver,
    sessionProbeClient: probe,
    ...(observation ? { observationSession: observation } : {}),
    async focus() {
      if (!browser.headless) await page.bringToFront();
    },
    async handoff() {
      revoked = true;
      raw.interaction.stop();
      await Promise.allSettled([...active]);
      if (page.isClosed()) throw new Error("页面已关闭，无法移交");
      owner = "HUMAN";
    },
    async release() {
      // A finished observation must not revoke the user's review page.
      if (owner === "HUMAN") await dispose();
      else await managed.close();
    },
    close() {
      if (owner === "HUMAN")
        return Promise.reject(
          new Error("人工页面只能由明确的用户关闭操作结束"),
        );
      return managed.closeByUser();
    },
    closeByUser() {
      closing ??= (async () => {
        revoked = true;
        raw.interaction.stop();
        await Promise.allSettled([...active]);
        await page.close();
        await dispose();
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
    dispose,
  };
  // Observation disposal belongs to its owner after queued responses are drained.
  page.once("close", () => {
    revoked = true;
    probe.dispose();
  });
  return managed;
}
