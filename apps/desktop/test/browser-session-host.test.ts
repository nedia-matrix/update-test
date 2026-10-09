import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import type { PlatformModule } from "@nedia-matrix/platform-sdk";
import { PlaywrightBrowserSessionHost } from "../src/main/accounts/infrastructure/playwright-browser-session-host.js";

const account = {
  id: "account-1",
  profileId: "matrix-account-1",
  externalAccountId: "external-1",
  identityScheme: "mock.id",
} as PlatformAccountSnapshot;
const platform = {
  browser: {
    startUrl: "https://creator.example.test",
    allowedHostSuffixes: ["example.test"],
    sessionCapabilities: {
      isolatedPages: true,
      parallelSync: true,
      headlessSync: true,
    },
  },
  accounts: { detection: { probes: [] } },
} as unknown as PlatformModule;
function fixture() {
  const browsers: Array<{
    context: EventEmitter;
    headless: boolean;
    channel: string;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const pages: any[] = [];
  const onClosed = vi.fn();
  const openContext = vi.fn(async (options: { headless?: boolean }) => {
    const context = Object.assign(new EventEmitter(), { pages: () => [] });
    const browser = {
      context,
      headless: options.headless ?? false,
      channel: "Google Chrome",
      close: vi.fn(async () => {
        context.emit("close");
      }),
    };
    browsers.push(browser);
    return browser;
  });
  const createPage = vi.fn(
    async (_browser, options, purpose, publicationId) => {
      const events = new EventEmitter();
      let closed = false;
      const page = {
        id: `page-${pages.length}`,
        profileId: options.profileId,
        purpose,
        publicationId,
        owner: "AUTOMATION",
        page: Object.assign(events, {
          isClosed: () => closed,
          context: () => _browser.context,
        }),
        driver: { navigate: vi.fn(async () => undefined) },
        sessionProbeClient: {
          fetchJson: vi.fn(async () => ({ status: 200, ok: true, body: {} })),
        },
        observationSession: {},
        focus: vi.fn(async () => undefined),
        handoff: vi.fn(async () => {
          page.owner = "HUMAN";
        }),
        close: vi.fn(async () => {
          closed = true;
          events.emit("close");
        }),
        dispose: vi.fn(async () => undefined),
        release: vi.fn(async () => {
          if (page.owner !== "HUMAN") await page.close();
        }),
      };
      pages.push(page);
      return page;
    },
  );
  const removeProfileDirectory = vi.fn(async () => undefined);
  const deps = {
    openContext,
    createPage,
    removeProfileDirectory,
    detectSession: vi.fn(async () => ({
      status: "authenticated",
      externalAccountId: account.externalAccountId,
      identityScheme: account.identityScheme,
    })),
    profilesRoot: () => "/profiles",
    evidenceRoot: () => "/evidence",
  };
  const host = new PlaywrightBrowserSessionHost(onClosed, deps as never);
  return { host, pages, browsers, deps, onClosed };
}

describe("isolated account browser sessions", () => {
  it.each([
    { status: 401, ok: false, body: {} },
    { status: 403, ok: false, body: {} },
    { status: 429, ok: false, body: {} },
    { status: 503, ok: false, body: null },
    { status: 200, ok: true, body: null },
    { status: 200, ok: true, body: {} },
  ])(
    "does not navigate or retry an identity response $status with body $body",
    async (response) => {
      const f = fixture();
      const sync = await f.host.openForVerification(account, platform);
      const probe = f.pages[0].sessionProbeClient.fetchJson;
      probe.mockResolvedValue(response);
      try {
        await expect(
          sync.sessionProbeClient.fetchJson(
            "https://creator.example.test/api/identity",
          ),
        ).resolves.toBe(response);
        expect(probe).toHaveBeenCalledOnce();
        expect(f.pages[0].driver.navigate).not.toHaveBeenCalled();
      } finally {
        await sync.close();
      }
    },
  );

  it.each([404, 405])(
    "can navigate once and retry a compatibility response %s",
    async (status) => {
      const f = fixture();
      const sync = await f.host.openForVerification(account, platform);
      const probe = f.pages[0].sessionProbeClient.fetchJson;
      const success = { status: 200, ok: true, body: { id: "external-1" } };
      probe
        .mockResolvedValueOnce({ status, ok: false, body: null })
        .mockResolvedValueOnce(success);
      try {
        await expect(
          sync.sessionProbeClient.fetchJson(
            "https://creator.example.test/api/identity",
          ),
        ).resolves.toBe(success);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(f.pages[0].driver.navigate).toHaveBeenCalledExactlyOnceWith(
          platform.browser.startUrl,
        );
      } finally {
        await sync.close();
      }
    },
  );
  it("records each browser candidate failure when opening an account page", async () => {
    const f = fixture();
    const failure = new Error("Unable to start a supported browser");
    failure.name = "BrowserLaunchError";
    Object.assign(failure, {
      failures: [
        { channel: "Google Chrome", message: "Executable not found" },
        { channel: "Microsoft Edge", message: "Launch timed out" },
      ],
    });
    f.deps.openContext.mockRejectedValueOnce(failure);
    const events: Array<{
      event: string;
      details?: Readonly<Record<string, unknown>>;
    }> = [];
    const diagnostics = {
      traceId: "trace-1",
      bind: () => undefined,
      report: (event: (typeof events)[number]) => events.push(event),
    };

    await expect(
      f.host.openUserPage(account, platform, diagnostics),
    ).rejects.toBe(failure);
    expect(
      events.filter(({ event }) => event === "browser.launch_candidate.failed"),
    ).toMatchObject([
      {
        details: {
          browserChannel: "Google Chrome",
          message: "Executable not found",
        },
      },
      {
        details: {
          browserChannel: "Microsoft Edge",
          message: "Launch timed out",
        },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      event: "browser.context.open_failed",
    });
  });

  it("shares one cold headless context for concurrent syncs and closes only after both release", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.host.openForVerification(account, platform),
      f.host.openForVerification(account, platform),
    ]);
    expect(f.deps.openContext).toHaveBeenCalledOnce();
    expect(f.browsers[0]!.headless).toBe(true);
    await Promise.all([a.close(), a.close()]);
    expect(f.browsers[0]!.close).not.toHaveBeenCalled();
    await b.close();
    expect(f.browsers[0]!.close).toHaveBeenCalledOnce();
    expect(f.onClosed).not.toHaveBeenCalled();
    expect(f.deps.openContext.mock.calls[0]![0]).toMatchObject({
      profileDirectory: "/profiles/matrix-account-1",
      headless: true,
    });
  });
  it("waits for headless sync before opening headed with the same profile and channel", async () => {
    const f = fixture();
    const sync = await f.host.openForVerification(account, platform);
    const user = f.host.openUserPage(account, platform);
    await Promise.resolve();
    expect(f.deps.openContext).toHaveBeenCalledOnce();
    await sync.close();
    await user;
    expect(f.deps.openContext.mock.calls[1]![0]).toMatchObject({
      headless: false,
      profileDirectory: "/profiles/matrix-account-1",
      preferredChannel: "Google Chrome",
    });
    expect(f.browsers[0]!.close).toHaveBeenCalledOnce();
  });
  it("keeps headed user and publication pages intact during sync", async () => {
    const f = fixture();
    const user = await f.host.openUserPage(account, platform);
    const publish = await f.host.openForPublication(
      account,
      platform,
      "publication-1",
    );
    const sync = await f.host.openForVerification(account, platform);
    await sync.close();
    expect(f.deps.openContext).toHaveBeenCalledOnce();
    expect(f.pages[0].driver.navigate).toHaveBeenCalledTimes(1);
    expect(f.pages[0].focus).toHaveBeenCalledTimes(1);
    expect(user.page.isClosed()).toBe(false);
    expect(publish.page.isClosed()).toBe(false);
    expect(f.browsers[0]!.close).not.toHaveBeenCalled();
  });
  it("closing the original user page does not restart the context or close publication", async () => {
    const f = fixture();
    const user = await f.host.openUserPage(account, platform);
    const publish = await f.host.openForPublication(
      account,
      platform,
      "publication-1",
    );
    await user.close();
    await f.host.openUserPage(account, platform);
    expect(f.deps.openContext).toHaveBeenCalledOnce();
    expect(publish.page.isClosed()).toBe(false);
  });
  it("retains human review and finds it by publication id", async () => {
    const f = fixture();
    const publish = await f.host.openForPublication(
      account,
      platform,
      "publication-1",
    );
    await publish.handoff();
    await publish.release();
    expect(publish.page.isClosed()).toBe(false);
    await f.host.focusPublication("publication-1");
    expect(f.pages[0].focus).toHaveBeenCalledOnce();
    await expect(f.host.focusPublication("other")).rejects.toThrow("已关闭");
  });
  it("blocks login, removal and another publication while a publication is active", async () => {
    const f = fixture();
    await f.host.openForPublication(account, platform, "publication-1");
    await expect(
      f.host.openForLogin(account, platform, {
        id: "login",
        displayName: "login",
        url: platform.browser.startUrl,
      }),
    ).rejects.toThrow("任务");
    await expect(f.host.remove(account)).rejects.toThrow("任务");
    await expect(
      f.host.openForPublication(account, platform, "publication-2"),
    ).rejects.toThrow("任务");
    expect(f.deps.removeProfileDirectory).not.toHaveBeenCalled();
  });
  it("retains a live context when closing fails and prevents profile deletion", async () => {
    const f = fixture();
    await f.host.openUserPage(account, platform);
    f.browsers[0]!.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(f.host.remove(account)).rejects.toThrow("close failed");
    expect(f.host.size).toBe(1);
    expect(f.deps.removeProfileDirectory).not.toHaveBeenCalled();
    await f.host.remove(account);
    expect(f.deps.removeProfileDirectory).toHaveBeenCalledOnce();
  });
  it("does not start a second instance if headless close fails", async () => {
    const f = fixture();
    const sync = await f.host.openForVerification(account, platform);
    f.browsers[0]!.close.mockRejectedValue(new Error("close failed"));
    await expect(sync.close()).rejects.toThrow("close failed");
    await expect(f.host.openUserPage(account, platform)).rejects.toThrow(
      "close failed",
    );
    expect(f.deps.openContext).toHaveBeenCalledOnce();
    expect(f.host.size).toBe(1);
  });
  it("ignores late closure of a replaced context", async () => {
    const f = fixture();
    const sync = await f.host.openForVerification(account, platform);
    await sync.close();
    await f.host.openUserPage(account, platform);
    f.browsers[0]!.context.emit("close");
    expect(f.host.size).toBe(1);
    expect(f.onClosed).not.toHaveBeenCalled();
  });
  it("does not silently open a visible browser for an unverified platform", async () => {
    const f = fixture();
    const conservative = {
      ...platform,
      browser: { ...platform.browser, sessionCapabilities: undefined },
    } as unknown as PlatformModule;
    await expect(
      f.host.openForVerification(account, conservative),
    ).rejects.toThrow("先打开");
    expect(f.deps.openContext).not.toHaveBeenCalled();
  });
  it("rejects a new publish page with another identity and cleans up", async () => {
    const f = fixture();
    f.deps.detectSession.mockResolvedValueOnce({
      status: "authenticated",
      externalAccountId: "other",
      identityScheme: account.identityScheme,
    });
    await expect(
      f.host.openForPublication(account, platform, "publication-1"),
    ).rejects.toThrow("身份");
    expect(f.pages[0].close).toHaveBeenCalledOnce();
    await f.host.openForPublication(account, platform, "publication-2");
  });
  it("binds publication browser events and evidence to the task trace", async () => {
    const f = fixture();
    const events: string[] = [];
    const bind = vi.fn();
    const diagnostics = {
      traceId: "11111111-1111-4111-8111-111111111111",
      bind,
      report: (event: { event: string }) => events.push(event.event),
      execution: () => ({}),
      finish: vi.fn(),
    };

    const publication = await f.host.openForPublication(
      account,
      platform,
      "publication-1",
      diagnostics as never,
    );
    await publication.handoff();

    expect(f.deps.createPage.mock.calls[0]![1]).toMatchObject({
      evidenceDirectory: "/evidence/11111111-1111-4111-8111-111111111111",
    });
    expect(bind).toHaveBeenCalledWith({ pageId: "page-0" });
    expect(events).toEqual(
      expect.arrayContaining([
        "browser.context.opened",
        "browser.page.opened",
        "session.detection.started",
        "session.detection.completed",
        "browser.page.handed_off",
      ]),
    );
  });
  it("binds sync browser lifecycle and evidence to its trace", async () => {
    const f = fixture();
    const events: string[] = [];
    const bind = vi.fn();
    const diagnostics = {
      traceId: "22222222-2222-4222-8222-222222222222",
      bind,
      report: (event: { event: string }) => events.push(event.event),
    };

    const sync = await f.host.openForVerification(
      account,
      platform,
      diagnostics,
    );
    await sync.close();

    expect(f.deps.createPage.mock.calls[0]![1]).toMatchObject({
      evidenceDirectory: "/evidence/22222222-2222-4222-8222-222222222222",
    });
    expect(bind).toHaveBeenCalledWith({ pageId: "page-0" });
    expect(events).toEqual([
      "browser.context.opening",
      "browser.context.opened",
      "browser.page.opening",
      "browser.page.opened",
      "browser.page.closed",
    ]);
  });
  it("prevents any new browser after shutdown", async () => {
    const f = fixture();
    await f.host.closeAll();
    await expect(f.host.openUserPage(account, platform)).rejects.toThrow(
      "shutting down",
    );
    expect(f.deps.openContext).not.toHaveBeenCalled();
  });
});
