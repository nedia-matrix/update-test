export { PlaywrightAutomationDriver } from "./automation-driver.js";
export {
  openPinnedBrowserScriptHost,
  type PinnedBrowserScriptAsset,
} from "./pinned-script-host.js";
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
export type { Response as PlaywrightResponse } from "playwright-core";
export {
  createManagedBrowserPage,
  type ManagedBrowserPage,
} from "./managed-browser-page.js";

export { HumanInteractionSession } from "./human-interaction.js";
export {
  browserRuntimeFromEnvironment,
  loadBrowserRuntime,
  initializeBrowserRuntime,
  readStoredBrowserRuntime,
  type StoredBrowserRuntime,
  verifyFingerprintBrowser,
  type BrowserRuntimeConfiguration,
} from "./browser-runtime.js";

export {
  fingerprintBrowserVersion,
  fingerprintBrowserAsset,
  installFingerprintBrowser,
  readFingerprintInstallation,
  recoverFingerprintInstallation,
  FingerprintInstallError,
  type FingerprintInstallErrorCode,
  type FingerprintInstallProgress,
  type FingerprintInstallerDependencies,
} from "./fingerprint-browser-installer.js";

export {
  contextRequestPacer,
  retryAfterMilliseconds,
} from "./request-pacing.js";
