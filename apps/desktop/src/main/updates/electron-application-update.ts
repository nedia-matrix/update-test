import type { ApplicationUpdateCheckResult } from "../../bridge/contracts.js";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { ipcChannels } from "../../bridge/channels.js";
import { UpdateController } from "./update-controller.js";
import { desktopPreferences } from "../preferences/desktop-preferences.js";
import { parseUpdateSource } from "./update-source.js";
import { findProtocolUpdate } from "./find-protocol-update.js";

import { findLatestRelease, releasePageUrl } from "./application-update.js";

declare const __NEDIA_UPDATE_PUBLIC_KEYS__: Record<string, string>;
declare const __NEDIA_UPDATE_DISTRIBUTION__: string;
let controller: UpdateController | undefined;
let revision = 0;

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
