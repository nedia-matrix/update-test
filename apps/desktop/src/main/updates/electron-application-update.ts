import type { ApplicationUpdateCheckResult } from "../../bridge/contracts.js";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { ipcChannels } from "../../bridge/channels.js";
import { UpdateController } from "./update-controller.js";
import { desktopPreferences } from "../preferences/desktop-preferences.js";
import { parseUpdateSource } from "./update-source.js";
import {
  prepareInstallation,
  recordUpdateStartup,
  type InstallContext,
  type PreparedInstallation,
} from "./update-installation.js";
import { findProtocolUpdate } from "./find-protocol-update.js";

import { findLatestRelease, releasePageUrl } from "./application-update.js";

declare const __NEDIA_UPDATE_PUBLIC_KEYS__: Record<string, string>;
declare const __NEDIA_UPDATE_DISTRIBUTION__: string;
let controller: UpdateController | undefined;
let revision = 0;
let installationLifecycle:
  | {
      acquire(): () => void;
      finish(prepared: PreparedInstallation): Promise<void>;
    }
  | undefined;
export function configureUpdateInstallation(
  lifecycle: NonNullable<typeof installationLifecycle>,
): void {
  installationLifecycle = lifecycle;
}
export function installationContext(): InstallContext {
  return {
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    distribution:
      typeof __NEDIA_UPDATE_DISTRIBUTION__ === "string"
        ? __NEDIA_UPDATE_DISTRIBUTION__
        : "unsupported",
    executable: process.execPath,
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
    portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
    resources: process.resourcesPath,
    userData: app.getPath("userData"),
    currentVersion: app.getVersion(),
  };
}
export const recordApplicationUpdateStartup = (completed: boolean) =>
  app.isPackaged
    ? recordUpdateStartup(installationContext(), completed)
    : Promise.resolve();
export const installApplicationUpdate = () => updates().install();

export const assertUpdateSourceIdle = () => controller?.assertCanChangeSource();
export function updateSourceChanged(): void {
  controller?.resetSource();
  controller = undefined;
  // Config has already persisted. Reset before checking so old prepared packages cannot be used.
  void updates()
    .check()
    .catch(() => undefined);
}

function updates(): UpdateController {
  if (controller) return controller;
  const source = parseUpdateSource(
    desktopPreferences().get().updates.sourceUrl,
  );
  const keys =
    typeof __NEDIA_UPDATE_PUBLIC_KEYS__ !== "undefined"
      ? __NEDIA_UPDATE_PUBLIC_KEYS__
      : {};
  controller ??= new UpdateController({
    currentVersion: app.getVersion(),
    source: source.kind,
    sourceIdentity: source.url,
    target: {
      platform: process.platform,
      arch: process.arch,
      distribution:
        typeof __NEDIA_UPDATE_DISTRIBUTION__ === "string"
          ? __NEDIA_UPDATE_DISTRIBUTION__
          : "unsupported",
    },
    keys,
    install: app.isPackaged
      ? async (update, installing) => {
          if (!installationLifecycle) throw new Error("安装生命周期尚未准备好");
          const release = installationLifecycle.acquire();
          let prepared: PreparedInstallation | undefined;
          let cleanupStarted = false;
          try {
            prepared = await prepareInstallation(installationContext(), update);
            cleanupStarted = true;
            installing();
            await installationLifecycle.finish(prepared);
          } catch (error) {
            await prepared?.cancel();
            throw error;
          } finally {
            if (!cleanupStarted) release();
          }
        }
      : undefined,
    cacheDirectory: join(app.getPath("userData"), "application-updates"),
    findLatestRelease: () =>
      source.kind === "github"
        ? findLatestRelease(undefined, "github", source.repository)
        : findProtocolUpdate(source, keys),
    onChange: (state) => {
      state.revision = ++revision;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send(ipcChannels.applicationUpdateChanged, state);
      }
    },
  });
  return controller;
}

export const getApplicationUpdateState = () => ({
  ...updates().snapshot(),
  revision,
});
export const downloadApplicationUpdate = () => updates().download();
// Shutdown should not construct an updater if it was never used.
export const cancelApplicationUpdateDownload = () =>
  controller?.cancel() ?? Promise.resolve();
export async function showApplicationUpdateFile(): Promise<void> {
  shell.showItemInFolder(await updates().verifiedDownloadedFile());
}

export function checkForApplicationUpdateNow(): Promise<ApplicationUpdateCheckResult> {
  return updates().check();
}

export async function openApplicationUpdateDownload(
  version: string,
): Promise<void> {
  const source = parseUpdateSource(
    desktopPreferences().get().updates.sourceUrl,
  );
  const pageUrl =
    source.kind === "github"
      ? releasePageUrl(version, "github", source.repository)
      : (controller?.signedDownloadUrl(version) ?? source.url);
  if (!pageUrl) throw new TypeError("Application update version is invalid");
  await shell.openExternal(pageUrl);
}
