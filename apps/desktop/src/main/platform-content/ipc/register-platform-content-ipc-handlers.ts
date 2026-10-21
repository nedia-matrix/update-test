import { ipcMain, shell } from "electron";

import { ipcChannels } from "../../../bridge/channels.js";
import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";

type PlatformContentIpcApplication = Pick<
  NediaMatrixUseCases,
  "platformContents"
>;

export function registerPlatformContentIpcHandlers(
  application: PlatformContentIpcApplication,
): void {
  ipcMain.handle(ipcChannels.listPlatformContents, (_event, request) => ({
    items: application.platformContents.list(request.accountId),
    latestRun:
      application.platformContents.latestRun(request.accountId) ?? null,
  }));
  ipcMain.handle(ipcChannels.refreshPlatformContents, (event, request) =>
    application.platformContents.refresh(request.accountId, (progress) => {
      if (!event.sender.isDestroyed())
        event.sender.send(ipcChannels.platformContentSyncProgress, progress);
    }),
  );
  ipcMain.handle(ipcChannels.openPlatformContent, async (_event, request) =>
    shell.openExternal(
      application.platformContents.contentUrl(
        request.accountId,
        request.externalContentId,
      ),
    ),
  );
}
