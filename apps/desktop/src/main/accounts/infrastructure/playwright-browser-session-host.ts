import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  browserProfileDirectory,
  createManagedBrowserPage,
  createPlaywrightPlatformDataClient,
  openPersistentBrowserContext,
  type ManagedBrowserPage,
  type OpenedBrowserContext,
} from "@nedia-matrix/automation-playwright";
import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import type { PublishAutomationDiagnosticTrace } from "@nedia-matrix/publishing";
import type {
  PlatformLoginEntry,
  PlatformModule,
} from "@nedia-matrix/platform-sdk";
import { app } from "electron";
import { detectPlatformSession } from "@nedia-matrix/automation-engine";

interface BrowserAutomationDiagnosticTrace {
  readonly traceId: string;
  bind(binding: { pageId?: string }): void;
  report(event: {
    component: "browser" | "session";
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    details?: Readonly<Record<string, unknown>>;
  }): void;
}

interface ProfileEntry {
  accountId: string;
  browser: OpenedBrowserContext;
  pages: Map<string, ManagedBrowserPage>;
  syncing: number;
  startupPages: ReturnType<OpenedBrowserContext["context"]["pages"]>;
  idle: Promise<void>;
  resolveIdle(): void;
}
interface Dependencies {
  openContext: typeof openPersistentBrowserContext;
  createPage: typeof createManagedBrowserPage;
  detectSession: typeof detectPlatformSession;
  removeProfileDirectory: typeof rm;
  profilesRoot(): string;
  evidenceRoot(): string;
}
const defaults: Dependencies = {
  openContext: openPersistentBrowserContext,
  createPage: createManagedBrowserPage,
  detectSession: detectPlatformSession,
  removeProfileDirectory: rm,
  profilesRoot: () => join(app.getPath("userData"), "browser-profiles"),
  evidenceRoot: () => join(app.getPath("userData"), "diagnostics", "evidence"),
};

export class PlaywrightBrowserSessionHost {
  private readonly profiles = new Map<string, ProfileEntry>();
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly channels = new Map<string, string>();
  private stopping = false;

  constructor(
    private readonly onSessionClosed: (accountId: string) => void,
    private readonly dependencies: Dependencies = defaults,
    private readonly onUnsupportedPopup: (publicationId: string) => void = () =>
      undefined,
  ) {}

  get size() {
    return this.profiles.size;
  }

  private options(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    diagnostics?: BrowserAutomationDiagnosticTrace,
  ) {
    return {
      browser: platform.browser,
      sessionDetection: platform.accounts.detection,
      profileId: account.profileId,
      profileDirectory: browserProfileDirectory(
        this.dependencies.profilesRoot(),
        account.profileId,
      ),
      evidenceDirectory: join(
        this.dependencies.evidenceRoot(),
        diagnostics?.traceId ?? account.id,
      ),
    };
  }

  private async ensureContext(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    headless: boolean,
  ) {
    if (this.stopping) throw new Error("Desktop is shutting down");
    let entry = this.profiles.get(account.profileId);
    if (entry?.browser.headless && !headless) {
      await entry.idle;
      await entry.browser.close();
      if (this.profiles.get(account.profileId) === entry)
        this.profiles.delete(account.profileId);
      entry = undefined;
    }
    if (entry) return entry;
    if (this.stopping) throw new Error("Desktop is shutting down");
    const channel = this.channels.get(account.profileId);
    const browser = await this.dependencies.openContext({
      ...this.options(account, platform),
      headless,
      ...(channel ? { preferredChannel: channel } : {}),
    });
    this.channels.set(account.profileId, browser.channel);
    const opened: ProfileEntry = {
      accountId: account.id,
      browser,
      pages: new Map(),
      syncing: 0,
      startupPages: browser.context
        .pages()
        .filter((page) => page.url() === "about:blank"),
      idle: Promise.resolve(),
      resolveIdle: () => undefined,
    };
    this.profiles.set(account.profileId, opened);
    browser.context.once("close", () => {
      if (this.profiles.get(account.profileId) !== opened) return;
      this.profiles.delete(account.profileId);
      // Closing a sync-only browser must not discard a pending publish media selection.
      if (!browser.headless) this.onSessionClosed(account.id);
    });
    for (const existingPage of browser.context.pages()) {
      if (existingPage.url() === "about:blank") continue;
      const managed = await this.dependencies.createPage(
        browser,
        this.options(account, platform),
        "user",
        undefined,
        existingPage,
      );
      await managed.handoff();
      opened.pages.set(managed.id, managed);
      existingPage.once("close", () => {
        opened.pages.delete(managed.id);
        void managed.dispose();
      });
    }
    return opened;
  }

  private async newPage(
    entry: ProfileEntry,
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    purpose: ManagedBrowserPage["purpose"],
    publicationId?: string,
    diagnostics?: BrowserAutomationDiagnosticTrace,
  ) {
    diagnostics?.report({
      component: "browser",
      event: "browser.page.opening",
      details: { purpose },
    });
    let page: ManagedBrowserPage;
    try {
      page = await this.dependencies.createPage(
        entry.browser,
        this.options(account, platform, diagnostics),
        purpose,
        publicationId,
      );
    } catch (error) {
      diagnostics?.report({
        component: "browser",
        event: "browser.page.open_failed",
        level: "error",
        details: {
          purpose,
          code: "BROWSER_PAGE_OPEN_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error ? error.message : "Unable to open page",
        },
      });
      throw error;
    }
    entry.pages.set(page.id, page);
    diagnostics?.bind({ pageId: page.id });
    diagnostics?.report({
      component: "browser",
      event: "browser.page.opened",
      details: { purpose, owner: page.owner },
    });
    page.page.on("popup", (popup) => {
      // Popups are human-owned, never silently included in the original result stream.
      void this.dependencies
        .createPage(
          entry.browser,
          this.options(account, platform),
          "user",
          undefined,
          popup,
        )
        .then(async (child) => {
          await child.handoff();
          entry.pages.set(child.id, child);
          popup.once("close", () => {
            entry.pages.delete(child.id);
            void child.dispose();
          });
          if (purpose === "publish" && publicationId)
            this.onUnsupportedPopup(publicationId);
        })
        .catch((error: unknown) =>
          console.error("Failed to register browser popup", error),
        );
    });
    // Discard only empty startup tabs after another page exists, never restored user pages.
    for (const initial of entry.startupPages) {
      if (
        initial !== page.page &&
        !initial.isClosed() &&
        initial.url() === "about:blank" &&
        ![...entry.pages.values()].some((managed) => managed.page === initial)
      ) {
        await initial.close();
      }
    }
    entry.startupPages = [];
    page.page.once("close", () => {
      diagnostics?.report({
        component: "browser",
        event: "browser.page.closed",
        details: { purpose, reason: "page_closed" },
      });
      // Publish entries remain active until the observation has persisted its terminal.
      if (purpose !== "publish") {
        entry.pages.delete(page.id);
        void page.dispose();
      }
    });
    page.page.once("crash", () => {
      diagnostics?.report({
        component: "browser",
        event: "browser.page.crashed",
        level: "error",
        details: {
          purpose,
          code: "BROWSER_PAGE_CRASHED",
          retryable: true,
        },
      });
    });
    return page;
  }

  async openForLogin(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    loginEntry: PlatformLoginEntry,
    diagnostics?: BrowserAutomationDiagnosticTrace,
  ) {
    diagnostics = isolateBrowserDiagnostics(diagnostics);
    return this.withProfileTransition(account.profileId, async () => {
      const entry = await this.openUserContext(
        account,
        platform,
        "login",
        diagnostics,
      );
      if (entry.syncing || this.hasPublication(entry))
        throw new Error("账号正在执行任务，请结束后再登录或切换账号");
      // Never navigate an existing human-owned page to perform login.
      const page = await this.newPage(
        entry,
        account,
        platform,
        "user",
        undefined,
        diagnostics,
      );
      try {
        await page.driver.navigate(loginEntry.url);
        await page.handoff();
        await page
          .focus()
          .catch((error: unknown) =>
            console.error("Unable to focus user page", error),
          );
        return page;
      } catch (error) {
        await page.close();
        throw error;
      }
    });
  }

  async openUserPage(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    diagnostics?: BrowserAutomationDiagnosticTrace,
  ) {
    diagnostics = isolateBrowserDiagnostics(diagnostics);
    return this.withProfileTransition(account.profileId, async () => {
      const entry = await this.openUserContext(
        account,
        platform,
        "user",
        diagnostics,
      );
      const existing = [...entry.pages.values()].find(
        (page) => page.purpose === "user" && !page.page.isClosed(),
      );
      if (existing) {
        diagnostics?.bind({ pageId: existing.id });
        await existing.focus();
        return existing;
      }
      const page = await this.newPage(
        entry,
        account,
        platform,
        "user",
        undefined,
        diagnostics,
      );
      try {
        await page.driver.navigate(platform.browser.startUrl);
        await page.handoff();
        await page
          .focus()
          .catch((error: unknown) =>
            console.error("Unable to focus user page", error),
          );
        return page;
      } catch (error) {
        await page.close();
        throw error;
      }
    });
  }

  private async openUserContext(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    purpose: "login" | "user",
    diagnostics?: BrowserAutomationDiagnosticTrace,
  ): Promise<ProfileEntry> {
    const reused = this.profiles.has(account.profileId);
    diagnostics?.report({
      component: "browser",
      event: "browser.context.opening",
      details: { purpose, headless: false },
    });
    try {
      const entry = await this.ensureContext(account, platform, false);
      diagnostics?.report({
        component: "browser",
        event: reused ? "browser.context.reused" : "browser.context.opened",
        details: {
          purpose,
          browserChannel: entry.browser.channel,
          headless: entry.browser.headless,
        },
      });
      return entry;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "BrowserLaunchError" &&
        "failures" in error &&
        Array.isArray(error.failures)
      ) {
        for (const failure of error.failures) {
          if (
            !failure ||
            typeof failure.channel !== "string" ||
            typeof failure.message !== "string"
          )
            continue;
          diagnostics?.report({
            component: "browser",
            event: "browser.launch_candidate.failed",
            level: "warn",
            details: {
              purpose,
              browserChannel: failure.channel,
              message: failure.message,
            },
          });
        }
      }
      diagnostics?.report({
        component: "browser",
        event: "browser.context.open_failed",
        level: "error",
        details: {
          purpose,
          code: "BROWSER_CONTEXT_OPEN_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error && error.name === "BrowserLaunchError"
              ? "All supported browser launch candidates failed"
              : error instanceof Error
                ? error.message
                : "Unable to open browser context",
        },
      });
      throw error;
    }
  }

  async openForPublication(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    publicationId: string,
    diagnostics?: PublishAutomationDiagnosticTrace,
  ) {
    diagnostics = isolateDiagnostics(diagnostics);
    return this.withProfileTransition(account.profileId, async () => {
      const reusedContext = this.profiles.has(account.profileId);
      diagnostics?.report({
        component: "browser",
        event: "browser.context.opening",
        details: { purpose: "publish", headless: false },
      });
      let entry: ProfileEntry;
      try {
        entry = await this.ensureContext(account, platform, false);
      } catch (error) {
        diagnostics?.report({
          component: "browser",
          event: "browser.context.open_failed",
          level: "error",
          details: {
            purpose: "publish",
            code: "BROWSER_CONTEXT_OPEN_FAILED",
            errorName: error instanceof Error ? error.name : "UnknownError",
            message:
              error instanceof Error
                ? error.message
                : "Unable to open browser context",
          },
        });
        throw error;
      }
      diagnostics?.report({
        component: "browser",
        event: reusedContext
          ? "browser.context.reused"
          : "browser.context.opened",
        details: {
          headless: entry.browser.headless,
          browserChannel: entry.browser.channel,
        },
      });
      if (entry.syncing || this.hasPublication(entry))
        throw new Error("账号正在执行任务");
      if (platform.browser.sessionCapabilities?.isolatedPages === false)
        throw new Error("此平台不支持独立发布页，请使用平台页面人工发布");
      const page = await this.newPage(
        entry,
        account,
        platform,
        "publish",
        publicationId,
        diagnostics,
      );
      const verifyIdentity = async () => {
        const startedAt = Date.now();
        diagnostics?.report({
          component: "session",
          event: "session.detection.started",
        });
        const detected = await this.dependencies.detectSession(
          platform.accounts.detection,
          page.driver,
          page.sessionProbeClient,
        );
        diagnostics?.report({
          component: "session",
          event: "session.detection.completed",
          details: {
            status: detected.status,
            ...(detected.status === "unknown"
              ? {}
              : { source: detected.source }),
            durationMs: Math.max(0, Date.now() - startedAt),
          },
        });
        if (
          detected.status !== "authenticated" ||
          detected.externalAccountId !== account.externalAccountId ||
          detected.identityScheme !== account.identityScheme
        ) {
          throw new Error(
            "独立发布页无法确认原账号身份，请重新登录或使用平台页面人工发布",
          );
        }
      };
      try {
        await page.driver.navigate(platform.browser.startUrl);
        await verifyIdentity();
      } catch (error) {
        await page.close();
        entry.pages.delete(page.id);
        throw error;
      }
      let released = false;
      return {
        ...page,
        verifyIdentity,
        get owner() {
          return page.owner;
        },
        async focus() {
          try {
            await page.focus();
            diagnostics?.report({
              component: "browser",
              event: "browser.page.focused",
            });
          } catch (error) {
            diagnostics?.report({
              component: "browser",
              event: "browser.page.focus_failed",
              level: "warn",
              details: {
                errorName: error instanceof Error ? error.name : "UnknownError",
                message:
                  error instanceof Error
                    ? error.message
                    : "Unable to focus page",
              },
            });
            throw error;
          }
        },
        async handoff() {
          await page.handoff();
          diagnostics?.report({
            component: "browser",
            event: "browser.page.handed_off",
            details: { owner: page.owner },
          });
        },
        async release() {
          if (released) return;
          await page.release();
          released = true;
          entry.pages.delete(page.id);
          // Keep completed review pages registered as user-owned resources.
          if (!page.page.isClosed()) {
            entry.pages.set(page.id, {
              ...page,
              purpose: "user",
              get owner() {
                return page.owner;
              },
            });
            page.page.once("close", () => entry.pages.delete(page.id));
          }
        },
      };
    });
  }

  async openForVerification(
    account: PlatformAccountSnapshot,
    platform: PlatformModule,
    diagnostics?: BrowserAutomationDiagnosticTrace,
  ) {
    diagnostics = isolateBrowserDiagnostics(diagnostics);
    const acquired = await this.withProfileTransition(
      account.profileId,
      async () => {
        const capabilities = platform.browser.sessionCapabilities;
        const existing = this.profiles.get(account.profileId);
        if (!existing && !capabilities?.headlessSync)
          throw new Error("此平台尚未启用无头同步，请先打开账号浏览器");
        if (
          existing &&
          this.hasPublication(existing) &&
          !capabilities?.parallelSync
        )
          throw new Error("此平台发布期间暂不支持并行同步");
        const reusedContext = this.profiles.has(account.profileId);
        diagnostics?.report({
          component: "browser",
          event: "browser.context.opening",
          details: { purpose: "sync", headless: true },
        });
        let entry: ProfileEntry;
        try {
          entry = await this.ensureContext(account, platform, true);
        } catch (error) {
          diagnostics?.report({
            component: "browser",
            event: "browser.context.open_failed",
            level: "error",
            details: {
              purpose: "sync",
              code: "BROWSER_CONTEXT_OPEN_FAILED",
              errorName: error instanceof Error ? error.name : "UnknownError",
              message:
                error instanceof Error
                  ? error.message
                  : "Unable to open browser context",
            },
          });
          throw error;
        }
        diagnostics?.report({
          component: "browser",
          event: reusedContext
            ? "browser.context.reused"
            : "browser.context.opened",
          details: {
            purpose: "sync",
            headless: entry.browser.headless,
            browserChannel: entry.browser.channel,
          },
        });
        let page: ManagedBrowserPage;
        try {
          page = await this.newPage(
            entry,
            account,
            platform,
            "sync",
            undefined,
            diagnostics,
          );
        } catch (error) {
          if (entry.browser.headless && entry.syncing === 0) {
            await entry.browser.close();
            if (this.profiles.get(account.profileId) === entry)
              this.profiles.delete(account.profileId);
          }
          throw error;
        }
        if (entry.syncing++ === 0)
          entry.idle = new Promise((resolve) => {
            entry.resolveIdle = resolve;
          });
        return { entry, page };
      },
    );
    const { entry, page } = acquired;
    const dataClient = createPlaywrightPlatformDataClient(
      entry.browser.context,
      page.page,
      platform.browser,
    );
    let closing: Promise<void> | undefined;
    let released = false;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        dataClient.dispose();
        await page.close();
        entry.pages.delete(page.id);
        released = true;
        if (--entry.syncing === 0) entry.resolveIdle();
        await this.withProfileTransition(account.profileId, async () => {
          if (
            this.profiles.get(account.profileId) === entry &&
            entry.browser.headless &&
            entry.syncing === 0
          ) {
            await entry.browser.close();
            if (this.profiles.get(account.profileId) === entry)
              this.profiles.delete(account.profileId);
          }
        });
      })().catch((error: unknown) => {
        if (!released) closing = undefined;
        throw error;
      }));
    let navigation: Promise<void> | undefined;
    const ensurePage = () =>
      (navigation ??= page.driver.navigate(platform.browser.startUrl));
    const probe = page.sessionProbeClient;
    const sessionProbeClient = {
      ...probe,
      async fetchJson(url: string) {
        const direct = await probe.fetchJson(url);
        if (direct.ok && direct.body !== null) return direct;
        // Only transport compatibility failures justify navigation and a retry.
        // Authentication, rate limits and challenge pages must stop here too.
        if (![404, 405].includes(direct.status)) return direct;
        await ensurePage();
        return probe.fetchJson(url);
      },
      async waitForJsonResponse(
        request: Parameters<typeof probe.waitForJsonResponse>[0],
      ) {
        await ensurePage();
        return probe.waitForJsonResponse(request);
      },
    };
    const driver = new Proxy(page.driver, {
      get(target, key, receiver) {
        const method: unknown = Reflect.get(target, key, receiver);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          if (key === "query") await ensurePage();
          return Reflect.apply(method, target, args);
        };
      },
    });
    return { driver, sessionProbeClient, dataClient, close };
  }

  async focusPublication(publicationId: string) {
    for (const entry of this.profiles.values()) {
      const page = [...entry.pages.values()].find(
        (candidate) =>
          candidate.publicationId === publicationId &&
          !candidate.page.isClosed(),
      );
      if (page) {
        await page.focus();
        return;
      }
    }
    throw new Error("任务页面已关闭");
  }

  hasPublicationPage(publicationId: string): boolean {
    return [...this.profiles.values()].some((entry) =>
      [...entry.pages.values()].some(
        (page) => page.publicationId === publicationId && !page.page.isClosed(),
      ),
    );
  }

  hasAnyPublicationPage(): boolean {
    return [...this.profiles.values()].some((entry) =>
      [...entry.pages.values()].some(
        (page) => page.purpose === "publish" && !page.page.isClosed(),
      ),
    );
  }

  private hasPublication(entry: ProfileEntry) {
    return [...entry.pages.values()].some((page) => page.purpose === "publish");
  }

  async closeAutomation(account: PlatformAccountSnapshot) {
    await this.withProfileTransition(account.profileId, async () => {
      const entry = this.profiles.get(account.profileId);
      if (!entry) return;
      if (entry.syncing || this.hasPublication(entry))
        throw new Error("账号仍有活动任务，暂不能关闭环境");
      await entry.browser.close();
      if (this.profiles.get(account.profileId) === entry)
        this.profiles.delete(account.profileId);
    });
  }
  async remove(account: PlatformAccountSnapshot) {
    await this.removeProfile(account.profileId);
  }
  async removeProfile(profileId: string) {
    await this.withProfileTransition(profileId, async () => {
      const entry = this.profiles.get(profileId);
      if (entry && (entry.syncing || this.hasPublication(entry)))
        throw new Error("账号仍有活动任务，暂不能删除环境");
      if (entry) await entry.browser.close();
      this.profiles.delete(profileId);
      await this.dependencies.removeProfileDirectory(
        browserProfileDirectory(this.dependencies.profilesRoot(), profileId),
        { recursive: true, force: true },
      );
      this.channels.delete(profileId);
    });
  }
  async closeAll() {
    this.stopping = true;
    await Promise.allSettled(this.transitions.values());
    await Promise.allSettled(
      [...this.profiles.values()].map(async (entry) => {
        await entry.idle;
        await entry.browser.close();
      }),
    );
  }
  private async withProfileTransition<T>(
    profileId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.transitions.get(profileId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.transitions.set(profileId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.transitions.get(profileId) === queued)
        this.transitions.delete(profileId);
    }
  }
}

function isolateBrowserDiagnostics(
  diagnostics: BrowserAutomationDiagnosticTrace | undefined,
): BrowserAutomationDiagnosticTrace | undefined {
  if (!diagnostics) return undefined;
  return {
    traceId: diagnostics.traceId,
    bind: (binding) => {
      try {
        diagnostics.bind(binding);
      } catch {
        // Diagnostics must not affect browser lifecycle.
      }
    },
    report: (event) => {
      try {
        diagnostics.report(event);
      } catch {
        // Diagnostics must not affect browser lifecycle.
      }
    },
  };
}

function isolateDiagnostics(
  diagnostics: PublishAutomationDiagnosticTrace | undefined,
): PublishAutomationDiagnosticTrace | undefined {
  if (!diagnostics) return undefined;
  return {
    traceId: diagnostics.traceId,
    bind: (binding) => {
      try {
        diagnostics.bind(binding);
      } catch {
        // Diagnostics must not affect browser lifecycle.
      }
    },
    report: (event) => {
      try {
        diagnostics.report(event);
      } catch {
        // Diagnostics must not affect browser lifecycle.
      }
    },
    execution: (phase) => {
      try {
        return diagnostics.execution(phase);
      } catch {
        return undefined;
      }
    },
    finish: (result) => {
      try {
        diagnostics.finish(result);
      } catch {
        // Diagnostics must not affect browser lifecycle.
      }
    },
  };
}
