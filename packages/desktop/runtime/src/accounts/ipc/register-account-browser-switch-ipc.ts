import { ipcMain } from "../../runtime/runtime-host.js";
import { ipcChannels } from "@nedia-matrix/desktop-contracts/channels";
import type { AccountBrowserSwitchService } from "../application/account-browser-switch-service.js";

export function registerAccountBrowserSwitchIpc(
  service: AccountBrowserSwitchService,
): void {
  ipcMain.handle(ipcChannels.getAccountBrowserState, (_event, request) =>
    service.accountState(request?.accountId),
  );
  ipcMain.handle(ipcChannels.beginAccountBrowserSwitch, (_event, request) =>
    service.begin({
      accountId: request?.accountId,
      targetProvider: request?.targetProvider,
    }),
  );
  ipcMain.handle(ipcChannels.getAccountBrowserSwitch, (_event, request) =>
    service.get(request?.operationId),
  );
  ipcMain.handle(ipcChannels.cancelAccountBrowserSwitch, (_event, request) =>
    service.cancel(request?.operationId),
  );
}
