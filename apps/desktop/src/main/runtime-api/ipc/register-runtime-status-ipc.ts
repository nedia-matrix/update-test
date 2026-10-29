import { ipcChannels } from "../../../bridge/channels.js";
import type { SetLocalRuntimeRunningRequest } from "../../../bridge/contracts.js";
import { ipcMain } from "electron";

import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";

export function registerRuntimeStatusIpcHandler(
  application: Pick<NediaMatrixUseCases, "runtime">,
): void {
  ipcMain.handle(ipcChannels.getLocalRuntimeStatus, () =>
    application.runtime.status(),
  );
  ipcMain.handle(
    ipcChannels.setLocalRuntimeRunning,
    async (_event, request: SetLocalRuntimeRunningRequest) => {
      if (typeof request?.running !== "boolean") {
        throw new TypeError("本地服务运行状态必须为布尔值");
      }
      return application.runtime.setRunning(request);
    },
  );
}
