import type { AccountBrowserRuntime } from "../../../bridge/account-browser-runtime.js";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import {
  browserProfileDirectory,
  createManagedBrowserPage,
  createPlaywrightPlatformDataClient,
  createPlaywrightSessionProbeClient,
  openPersistentBrowserContext,
  readStoredBrowserRuntime,
  type BrowserRuntimeConfiguration,
  type ManagedBrowserPage,
  type OpenedBrowserContext,
} from "@nedia-matrix/automation-playwright";
import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import type { PublishAutomationDiagnosticTrace } from "@nedia-matrix/publishing";
import type {
  PlatformDataClient,
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
  runtime: BrowserRuntimeConfiguration;
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

export type OpenPlatformDataClient = (input: {
  base: PlatformDataClient;
  context: OpenedBrowserContext["context"];
  account: PlatformAccountSnapshot;
  platform: PlatformModule;
  assertOwnership(): void;
}) => { dataClient: PlatformDataClient; close(): Promise<void> };

export class PlaywrightBrowserSessionHost {
  private readonly profiles = new Map<string, ProfileEntry>();
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly channels = new Map<string, string>();
  private stopping = false;
  private browserMaintenance: symbol | undefined;
  private readonly browserSwitches = new Map<
    string,
    { originalProfileId: string; candidateProfileId: string }
  >();

  constructor(
    private readonly onSessionClosed: (
      accountId: string,
      profileId: string,
    ) => void,
    private readonly dependencies: Dependencies = defaults,
    private readonly onUnsupportedPopup: (publicationId: string) => void = () =>
      undefined,
    private readonly onRuntimesChanged: (
      runtimes: AccountBrowserRuntime[],
    ) => void = () => undefined,
    private readonly openDataClient?: OpenPlatformDataClient,
  ) {}

  listAccountBrowserRuntimes(): AccountBrowserRuntime[] {
    const modes = new Map<string, AccountBrowserRuntime["mode"]>();
    for (const entry of this.profiles.values()) {
      const mode = entry.browser.headless ? "background" : "window";
      if (modes.get(entry.accountId) !== "window")
        modes.set(entry.accountId, mode);
    }
    return [...modes].map(([accountId, mode]) => ({ accountId, mode }));
  }

  private forgetProfile(profileId: string): void {
    if (this.profiles.delete(profileId))
      this.onRuntimesChanged(this.listAccountBrowserRuntimes());
  }

  acquireBrowserMaintenance(managedRoot?: string): () => void {
    const canonical = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    };
    const root = managedRoot ? canonical(managedRoot) : undefined;
    if (
      this.stopping ||
      this.browserMaintenance ||
      this.browserSwitches.size ||
      this.transitions.size ||
      [...this.profiles.values()].some((entry) => {
        if (entry.runtime.provider !== "fingerprint") return false;
        if (!root) return true;
        const part = relative(root, canonical(entry.runtime.executablePath!));
        return (
          !!part && !isAbsolute(part) && !part.split(/[\\/]/).includes("..")
        );
      })
    )
      throw new Error("浏览器环境正在使用");
    const token = Symbol("browser-maintenance");
    this.browserMaintenance = token;
    return () => {
      if (this.browserMaintenance === token)
        this.browserMaintenance = undefined;
    };
  }

  isBrowserUnderMaintenance(): boolean {
    return this.browserMaintenance !== undefined;
  }

  isAccountBrowserBusy(accountId: string, profileId: string): boolean {
    return (
      this.transitions.has(profileId) ||
      [...this.profiles.entries()].some(
        ([id, entry]) =>
          !(
            id === this.browserSwitches.get(accountId)?.candidateProfileId &&
            id !== profileId
          ) &&
          (entry.accountId === accountId || id === profileId) &&
          (entry.syncing > 0 ||
            [...entry.pages.values()].some(
              (page) => page.purpose === "publish" || !page.page.isClosed(),
            )),
      )
    );
  }

  acquireAccountBrowserSwitch(
    accountId: string,
    originalProfileId: string,
    candidateProfileId: string,
  ): () => void {
    if (
      this.stopping ||
      this.browserMaintenance ||
      this.browserSwitches.has(accountId) ||
      this.isAccountBrowserBusy(accountId, originalProfileId)
    )
      throw new Error("账号浏览器仍有活动任务或人工页面，请先关闭相关页面");
    const lease = { originalProfileId, candidateProfileId };
    this.browserSwitches.set(accountId, lease);
    return () => {
      if (this.browserSwitches.get(accountId) === lease)
        this.browserSwitches.delete(accountId);
    };
  }

  invalidateProfileChannels(...profileIds: string[]): void {
    for (const profileId of profileIds) this.channels.delete(profileId);
  }

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
    if (this.browserMaintenance)
      throw new Error("定制浏览器正在安装或修复，请等待完成");
    const switching = this.browserSwitches.get(account.id);
    if (switching && account.profileId !== switching.candidateProfileId)
      throw new Error("账号正在切换浏览器环境");
    let entry = this.profiles.get(account.profileId);
    if (entry && entry.accountId !== account.id)
      throw new Error(
        "Browser Profile is owned by another account; shared profiles are unsupported",
      );
    if (entry?.browser.headless && !headless) {
      // A visible login/user request must never close an in-flight API publication.
      if (this.hasPublication(entry))
        throw new Error("账号正在后台发布，请任务结束后再打开浏览器");
      await entry.idle;
      await entry.browser.close();
      if (this.profiles.get(account.profileId) === entry)
        this.forgetProfile(account.profileId);
      entry = undefined;
    }
    if (entry) return entry;
    if (this.stopping) throw new Error("Desktop is shutting down");
    const channel = this.channels.get(account.profileId);
    const stored = await readStoredBrowserRuntime(
      browserProfileDirectory(
        this.dependencies.profilesRoot(),
        account.profileId,
      ),
    );
    // Historical profiles without metadata are system profiles. Desktop never
    // lets environment variables migrate them or override a pinned external binary.
    const runtime: BrowserRuntimeConfiguration = stored
      ? {
          provider: stored.provider,
          ...(stored.executablePath
            ? { executablePath: stored.executablePath }
            : {}),
        }
      : { provider: "system" };
    const browser = await this.dependencies.openContext({
      ...this.options(account, platform),
      headless,
      runtime,
      ...(channel ? { preferredChannel: channel } : {}),
    });
    this.channels.set(account.profileId, browser.channel);
    const opened: ProfileEntry = {
      runtime,
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
      this.forgetProfile(account.profileId);
      // Closing a sync-only browser must not discard a pending publish media selection.
      if (!browser.headless)
        this.onSessionClosed(account.id, account.profileId);
    });
    this.onRuntimesChanged(this.listAccountBrowserRuntimes());
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
          if (purpose === "publish" && page.publicationId)
            this.onUnsupportedPopup(page.publicationId);
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
    publicationId: string | undefined,
    diagnostics?: PublishAutomationDiagnosticTrace,
  ) {
    diagnostics = isolateDiagnostics(diagnostics);
    return this.withProfileTransition(account.profileId, async () => {
      const headless =
        platform.publishing?.executionMode === "publisher" &&
        platform.browser.sessionCapabilities?.headlessPublish === true;
      const reusedContext = this.profiles.has(account.profileId);
      diagnostics?.report({
        component: "browser",
        event: "browser.context.opening",
        details: { purpose: "publish", headless },
      });
      let entry: ProfileEntry;
      try {
        entry = await this.ensureContext(account, platform, headless);
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
      let page: ManagedBrowserPage;
      try {
        page = await this.newPage(
          entry,
          account,
          platform,
          "publish",
          publicationId,
          diagnostics,
        );
      } catch (error) {
        await this.closeIdleBackground(account.profileId, entry);
        throw error;
      }
      const verifyIdentity = async () => {
        const startedAt = Date.now();
        diagnostics?.report({
          component: "session",
          event: "session.detection.started",
        });
        // API preparation can outlive the original page response's replay window.
        // Subscribe before navigating so each recheck gets fresh page evidence,
        // including when preparation finished within the replay window.
        const freshProbe =
          platform.publishing?.executionMode === "publisher"
            ? createPlaywrightSessionProbeClient(
                entry.browser.context,
                page.page,
                platform.browser,
                platform.accounts.detection,
              )
            : undefined;
        let detected;
        try {
          if (freshProbe) await page.driver.navigate(platform.browser.startUrl);
          detected = await this.dependencies.detectSession(
            platform.accounts.detection,
            page.driver,
            freshProbe ?? page.sessionProbeClient,
          );
        } finally {
          freshProbe?.dispose();
        }
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
        if (
          !publicationId ||
          platform.publishing?.executionMode !== "publisher"
        )
          await page.driver.navigate(platform.browser.startUrl);
        // Unbound pages are verified by the account service during preflight.
        // It also persists detection results and returns actionable login errors.
        if (publicationId) await verifyIdentity();
      } catch (error) {
        await page.close();
        entry.pages.delete(page.id);
        await this.closeIdleBackground(account.profileId, entry);
        throw error;
      }
      let released = false;
      const releaseBackground = () =>
        this.withProfileTransition(account.profileId, () =>
          this.closeIdleBackground(account.profileId, entry),
        );
      return {
        ...page,
        bindPublication(id: string) {
          if (page.publicationId && page.publicationId !== id)
            throw new Error("发布页已绑定其他任务");
          Object.defineProperty(page, "publicationId", {
            value: id,
            configurable: true,
            enumerable: true,
          });
        },
        get publicationId() {
          return page.publicationId;
        },
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
          if (released) {
            await releaseBackground();
            return;
          }
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
          await releaseBackground();
        },
      };
    });
  }

  private async closeIdleBackground(
    profileId: string,
    entry: ProfileEntry,
  ): Promise<void> {
    if (
      this.profiles.get(profileId) !== entry ||
      !entry.browser.headless ||
      entry.syncing > 0 ||
      entry.pages.size > 0
    )
      return;
    await entry.browser.close();
    if (this.profiles.get(profileId) === entry) this.forgetProfile(profileId);
  }

  requirePublicationContext(input: {
    accountId: string;
    profileId: string;
    pageId: string;
    publicationId: string;
  }) {
    const entry = this.profiles.get(input.profileId);
    const page = entry?.pages.get(input.pageId);
    if (
      !entry ||
      entry.accountId !== input.accountId ||
      !page ||
      page.purpose !== "publish" ||
      page.publicationId !== input.publicationId ||
      page.page.isClosed()
    )
      throw new Error("Publication browser ownership could not be verified");
    return entry.browser.context;
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
              this.forgetProfile(account.profileId);
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
    const baseDataClient = createPlaywrightPlatformDataClient(
      entry.browser.context,
      page.page,
      platform.browser,
    );
    // Factory is lazy: a missing signing asset is reported on the first API request,
    // while close still owns and drains the helper before releasing the Profile.
    let custom: ReturnType<OpenPlatformDataClient> | undefined;
    try {
      custom = this.openDataClient?.({
        base: baseDataClient,
        context: entry.browser.context,
        account,
        platform,
        assertOwnership: () => {
          if (
            this.profiles.get(account.profileId) !== entry ||
            entry.accountId !== account.id ||
            entry.pages.get(page.id) !== page ||
            page.page.isClosed()
          )
            throw new Error("Sync browser ownership could not be verified");
        },
      });
    } catch (error) {
      baseDataClient.dispose();
      try {
        await page.close();
      } finally {
        entry.pages.delete(page.id);
        if (--entry.syncing === 0) entry.resolveIdle();
        await this.withProfileTransition(account.profileId, () =>
          this.closeIdleBackground(account.profileId, entry),
        );
      }
      throw error;
    }
    const dataClient = custom?.dataClient ?? baseDataClient;
    let closing: Promise<void> | undefined;
    let released = false;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        dataClient.dispose();
        await custom?.close();
        await page.close();
        entry.pages.delete(page.id);
        released = true;
        if (--entry.syncing === 0) entry.resolveIdle();
        await this.withProfileTransition(account.profileId, async () => {
          if (
            this.profiles.get(account.profileId) === entry &&
            entry.browser.headless &&
            entry.syncing === 0 &&
            !this.hasPublication(entry)
          ) {
            await entry.browser.close();
            if (this.profiles.get(account.profileId) === entry)
              this.forgetProfile(account.profileId);
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
        this.forgetProfile(account.profileId);
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
      this.forgetProfile(profileId);
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
