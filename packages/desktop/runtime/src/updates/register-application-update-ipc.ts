import { ipcChannels } from "@nedia-matrix/desktop-contracts/channels";
import type { OpenApplicationUpdateDownloadRequest } from "@nedia-matrix/desktop-contracts/contracts";
import { ipcMain } from "../runtime/runtime-host.js";

import type { NediaMatrixUseCases } from "../application/nedia-matrix-application.js";

export function registerApplicationUpdateIpcHandler(
  application: Pick<NediaMatrixUseCases, "updates">,
): void {
  ipcMain.handle(ipcChannels.getApplicationUpdateState, () =>
    application.updates.state(),
  );
  ipcMain.handle(ipcChannels.downloadApplicationUpdate, () =>
    application.updates.download(),
  );
  ipcMain.handle(ipcChannels.cancelApplicationUpdateDownload, () =>
    application.updates.cancelDownload(),
  );
  ipcMain.handle(ipcChannels.installApplicationUpdate, () =>
    application.updates.install(),
  );
  ipcMain.handle(ipcChannels.showApplicationUpdateFile, () =>
    application.updates.showFile(),
  );
  ipcMain.handle(ipcChannels.checkForApplicationUpdate, () =>
    application.updates.check(),
  );
  ipcMain.handle(
    ipcChannels.openApplicationUpdateDownload,
    (_event, request: OpenApplicationUpdateDownloadRequest) => {
      if (typeof request?.version !== "string") {
        throw new TypeError("Application update version must be a string");
      }
      return application.updates.openDownload(request);
    },
  );
}
