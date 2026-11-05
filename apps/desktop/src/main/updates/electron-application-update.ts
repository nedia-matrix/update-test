import { IS_TAURI } from "../../bridge/update-source.js";
import { businessDataDirectory } from "../runtime/desktop-data-paths.js";
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
// Both Windows payloads share the sidecar build. Only the portable launcher sets
// its original EXE location; NSIS continues to target the installed GUI executable.
function updateDistribution(): string {
  if (
    IS_TAURI &&
    process.platform === "win32" &&
    (process.env.PORTABLE_EXECUTABLE_FILE ||
      process.env.PORTABLE_EXECUTABLE_DIR)
  )
    return "portable";
  return typeof __NEDIA_UPDATE_DISTRIBUTION__ === "string"
    ? __NEDIA_UPDATE_DISTRIBUTION__
    : "unsupported";
}
export function installationContext(): InstallContext {
  return {
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    distribution: updateDistribution(),
    executable: IS_TAURI
      ? process.env.NEDIA_TAURI_EXECUTABLE!
      : process.execPath,
    parentPid: IS_TAURI
      ? Number(process.env.NEDIA_TAURI_PARENT_PID)
      : undefined,
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
    portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
    resources: IS_TAURI
      ? process.env.NEDIA_TAURI_RUNTIME!
      : process.resourcesPath,
    userData: businessDataDirectory(),
    currentVersion: app.getVersion(),
  };
}
export const recordApplicationUpdateStartup = (
  completed: boolean,
  stagePlugins?: () => void,
) =>
  app.isPackaged
    ? recordUpdateStartup(
        installationContext(),
        completed,
        (file) => shell.trashItem(file),
        stagePlugins,
      )
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
      distribution: updateDistribution(),
    },
    keys,
    install: app.isPackaged
      ? async (update, installing) => {
          if (!installationLifecycle) throw new Error("安装生命周期尚未准备好");
          const release = installationLifecycle.acquire();
          let prepared: PreparedInstallation | undefined;
          let cleanupStarted = false;
          try {
            prepared = await prepareInstallation(
              {
                ...installationContext(),
                includePlugins:
                  desktopPreferences().get().updates.includePlugins,
              },
              update,
            );
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
    cacheDirectory: join(businessDataDirectory(), "application-updates"),
    findLatestRelease: () =>
      source.kind === "manifest"
        ? findProtocolUpdate(source, keys)
        : findLatestRelease(undefined, source.kind, source.repository),
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
  await shell.showItemInFolder(await updates().verifiedDownloadedFile());
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
    source.kind === "manifest"
      ? (controller?.signedDownloadUrl(version) ?? source.url)
      : releasePageUrl(version, source.kind, source.repository);
  if (!pageUrl) throw new TypeError("Application update version is invalid");
  await shell.openExternal(pageUrl);
}
