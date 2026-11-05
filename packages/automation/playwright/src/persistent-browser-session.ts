import { mkdir } from "node:fs/promises";
import {
  assertBrowserProfileCompatible,
  readBrowserProfileRequirements,
  reserveBrowserProfileVersion,
  playwrightRuntimeVersion,
} from "./browser-profile-compatibility.js";
import { bindProfileRequestPacer } from "./request-pacing.js";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { SessionDetectionPlan } from "@nedia-matrix/automation-engine";
import type {
  PlatformBrowserPolicy,
  PublishObservationSession,
} from "@nedia-matrix/platform-sdk";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import {
  fingerprintArguments,
  loadBrowserRuntime,
  previewBrowserRuntime,
  saveBrowserRuntime,
  verifyFingerprintBrowser,
  type BrowserRuntimeConfiguration,
  type StoredBrowserRuntime,
} from "./browser-runtime.js";
import { PlaywrightAutomationDriver } from "./automation-driver.js";
import { isAllowedPlatformNavigation } from "./navigation-policy.js";
import { createPlaywrightPublishObservationSession } from "./publish-observation-session.js";
import {
  createPlaywrightSessionProbeClient,
  type PlaywrightSessionProbeClient,
} from "./session-probe-client.js";

export interface OpenPersistentBrowserSessionOptions {
  browser: PlatformBrowserPolicy;
  sessionDetection: SessionDetectionPlan;
  profileDirectory: string;
  profileId: string;
  evidenceDirectory: string;
  headless?: boolean;
  preferredChannel?: string;
  runtime?: BrowserRuntimeConfiguration;
}

export interface OpenedPersistentBrowserSession {
  id: string;
  profileId: string;
  context: BrowserContext;
  page: Page;
  driver: PlaywrightAutomationDriver;
  sessionProbeClient: PlaywrightSessionProbeClient;
  observationSession: PublishObservationSession;
  focus(): Promise<void>;
  close(): Promise<void>;
}

interface BrowserLaunchCandidate {
  name: string;
  options: PersistentBrowserOptions;
}

export class BrowserLaunchError extends Error {
  readonly failures: readonly { channel: string; message: string }[];

  constructor(
    failures: readonly { channel: string; message: string }[],
    fingerprint = false,
  ) {
    super(
      `Unable to start a supported browser. ${fingerprint ? "Reinstall the configured fingerprint browser with pnpm browser:install:fingerprint; system fallback is disabled." : "Install Google Chrome or Microsoft Edge and try again."} ${failures.map(({ channel, message }) => `${channel}: ${message}`).join("\n")}`,
    );
    this.name = "BrowserLaunchError";
    this.failures = failures;
  }
}

type PersistentBrowserOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

export function browserLaunchCandidates(): BrowserLaunchCandidate[] {
  return [
    { name: "Google Chrome", options: { channel: "chrome" } },
    { name: "Microsoft Edge", options: { channel: "msedge" } },
    { name: "Playwright Chromium", options: {} },
  ];
}

async function launchPersistentBrowser(
  profileDirectory: string,
  headless = false,
  preferredChannel: string | undefined,
  runtime: StoredBrowserRuntime,
  requestedRuntime?: BrowserRuntimeConfiguration,
): Promise<{
  context: BrowserContext;
  channel: string;
  browserVersion: string;
}> {
  const failures: { channel: string; message: string }[] = [];
  const sharedOptions: PersistentBrowserOptions = {
    headless,
    chromiumSandbox: true,
    viewport: null,
    locale: runtime.locale,
    timezoneId: runtime.timezoneId,
    acceptDownloads: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };

  if (runtime.provider === "fingerprint")
    await verifyFingerprintBrowser(runtime.executablePath!);
  const candidates =
    runtime.provider === "fingerprint"
      ? [
          {
            name: "Fingerprint Chromium",
            options: { executablePath: runtime.executablePath },
          },
        ]
      : browserLaunchCandidates();
  const requirements = await readBrowserProfileRequirements(profileDirectory);
  const pinnedChannel =
    runtime.provider === "fingerprint"
      ? "Fingerprint Chromium"
      : (runtime.channel ??
        (requirements.saved?.provider === runtime.provider
          ? requirements.saved.channel
          : undefined) ??
        preferredChannel);
  const selected = pinnedChannel
    ? candidates.filter((candidate) => candidate.name === pinnedChannel)
    : candidates;
  const explicitFingerprintSwitch =
    runtime.provider === "fingerprint" &&
    requirements.saved?.provider === "system";
  for (const candidate of selected) {
    const candidateOptions =
      candidate.name === "Playwright Chromium"
        ? { executablePath: chromium.executablePath() }
        : candidate.options;
    let browserVersion: string;
    try {
      const probe = await chromium.launch({
        ...candidateOptions,
        headless: true,
        chromiumSandbox: true,
        timeout: 30_000,
        ...(runtime.provider === "fingerprint"
          ? { args: fingerprintArguments(runtime.fingerprintSeed) }
          : {}),
      });
      try {
        browserVersion = probe.version();
      } finally {
        await probe.close();
      }
    } catch (error) {
      failures.push({
        channel: candidate.name,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const selectedVersion = {
      provider: runtime.provider,
      channel: candidate.name,
      browserVersion,
    };
    assertBrowserProfileCompatible(
      requirements,
      selectedVersion,
      explicitFingerprintSwitch,
    );
    await mkdir(profileDirectory, { recursive: true });
    runtime = await loadBrowserRuntime(profileDirectory, requestedRuntime);
    await reserveBrowserProfileVersion(
      profileDirectory,
      selectedVersion,
      explicitFingerprintSwitch,
    );
    await saveBrowserRuntime(profileDirectory, {
      ...runtime,
      channel: candidate.name,
    });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDirectory, {
        ...sharedOptions,
        ...candidateOptions,
        ignoreDefaultArgs: [
          "--disable-component-extensions-with-background-pages",
          "--disable-extensions",
        ],
        args: [
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          ...(runtime.provider === "fingerprint"
            ? fingerprintArguments(runtime.fingerprintSeed)
            : []),
        ],
      });
    } catch (error) {
      // A failed persistent launch may already have touched the profile. Never
      // retry another channel against it or bypass its existing browser lock.
      throw new BrowserLaunchError(
        [
          ...failures,
          {
            channel: candidate.name,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        runtime.provider === "fingerprint",
      );
    }
    return { context, channel: candidate.name, browserVersion };
  }

  throw new BrowserLaunchError(failures, runtime.provider === "fingerprint");
}

/** Legacy single-page adapter; Desktop uses the context and managed-page APIs. */
export async function openPersistentBrowserSession(
  options: OpenPersistentBrowserSessionOptions,
): Promise<OpenedPersistentBrowserSession> {
  const { context } = await openPersistentBrowserContext(options);

  try {
    const existingPage = context
      .pages()
      .find((candidate) =>
        isAllowedPlatformNavigation(candidate.url(), options.browser),
      );
    const page =
      existingPage ?? context.pages()[0] ?? (await context.newPage());
    const sessionProbeClient = createPlaywrightSessionProbeClient(
      context,
      page,
      options.browser,
      options.sessionDetection,
    );
    if (!isAllowedPlatformNavigation(page.url(), options.browser)) {
      await page.goto(options.browser.startUrl, {
        waitUntil: "domcontentloaded",
      });
    }

    const driver = new PlaywrightAutomationDriver(
      page,
      options.browser,
      options.evidenceDirectory,
    );
    return {
      id: randomUUID(),
      profileId: options.profileId,
      context,
      page,
      driver,
      sessionProbeClient,
      observationSession: await createPlaywrightPublishObservationSession(
        context,
        page,
      ),
      async focus() {
        await page.bringToFront();
      },
      async close() {
        sessionProbeClient.dispose();
        await context.close();
      },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export interface OpenedBrowserContext {
  context: BrowserContext;
  channel: string;
  headless: boolean;
  browserVersion?: string;
  playwrightVersion?: string;
  close(): Promise<void>;
}

/** Opens the original account profile without assigning any page a business role. */
export async function openPersistentBrowserContext(
  options: OpenPersistentBrowserSessionOptions,
): Promise<OpenedBrowserContext> {
  if (!isAbsolute(options.profileDirectory)) {
    throw new TypeError("Browser profile directory must be an absolute path");
  }
  await readBrowserProfileRequirements(options.profileDirectory);
  const { runtime } = await previewBrowserRuntime(
    options.profileDirectory,
    options.runtime,
  );
  const { context, channel, browserVersion } = await launchPersistentBrowser(
    options.profileDirectory,
    options.headless,
    options.preferredChannel,
    runtime,
    options.runtime,
  );
  bindProfileRequestPacer(context, options.profileDirectory);
  return {
    context,
    channel,
    browserVersion,
    playwrightVersion: playwrightRuntimeVersion,
    headless: options.headless ?? false,
    close: () => context.close(),
  };
}
