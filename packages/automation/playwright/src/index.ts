export { PlaywrightAutomationDriver } from "./automation-driver.js";
export { isAllowedPlatformNavigation } from "./navigation-policy.js";
export { createPlaywrightPlatformDataClient } from "./platform-data-client.js";
export {
  BrowserLaunchError,
  browserLaunchCandidates,
  openPersistentBrowserContext,
  type OpenedBrowserContext,
  openPersistentBrowserSession,
  type OpenedPersistentBrowserSession,
  type OpenPersistentBrowserSessionOptions,
} from "./persistent-browser-session.js";
export { createPlaywrightPublishObservationSession } from "./publish-observation-session.js";
export { browserProfileDirectory, createBrowserProfileId } from "./profile.js";
export {
  createPlaywrightSessionProbeClient,
  type PlaywrightSessionProbeClient,
} from "./session-probe-client.js";
export type { Response as PlaywrightResponse } from "playwright";
export {
  createManagedBrowserPage,
  type ManagedBrowserPage,
} from "./managed-browser-page.js";

export { HumanInteractionSession } from "./human-interaction.js";
export {
  browserRuntimeFromEnvironment,
  loadBrowserRuntime,
  verifyFingerprintBrowser,
  type BrowserRuntimeConfiguration,
} from "./browser-runtime.js";
