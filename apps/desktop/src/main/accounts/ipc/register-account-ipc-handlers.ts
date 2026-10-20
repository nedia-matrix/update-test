import { ipcChannels } from "../../../bridge/channels.js";
import { ipcMain } from "electron";

import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";

import type { AccountBrowserRuntime } from "../../../bridge/account-browser-runtime.js";

type AccountIpcApplication = Pick<
  NediaMatrixUseCases,
  "accounts" | "platformSummaries"
>;

export function registerAccountIpcHandlers(
  application: AccountIpcApplication,
  browserRuntimes: { listAccountBrowserRuntimes(): AccountBrowserRuntime[] },
): void {
  ipcMain.handle(ipcChannels.listAccountBrowserRuntimes, () =>
    browserRuntimes.listAccountBrowserRuntimes(),
  );
  ipcMain.handle(ipcChannels.listPlatforms, () =>
    application.platformSummaries(),
  );
  ipcMain.handle(ipcChannels.setAccountSettings, (_event, request) => {
    if (!application.accounts.setSettings)
      throw new Error("账号发布设置不可用");
    return application.accounts.setSettings(request);
  });
  ipcMain.handle(ipcChannels.listPlatformAccounts, () =>
    application.accounts.list(),
  );
  ipcMain.handle(ipcChannels.createPlatformAccount, (_event, request) =>
    application.accounts.create(request),
  );
  ipcMain.handle(ipcChannels.openPlatformLogin, (_event, request) =>
    application.accounts.openLogin(request),
  );
  ipcMain.handle(ipcChannels.openPlatformAccount, (_event, request) =>
    application.accounts.open(request),
  );
  ipcMain.handle(ipcChannels.refreshPlatformAccount, (_event, request) =>
    application.accounts.refresh(request),
  );
  ipcMain.handle(ipcChannels.refreshPlatformAccountProfile, (_event, request) =>
    application.accounts.refreshProfile(request),
  );
  ipcMain.handle(ipcChannels.removePlatformAccount, (_event, request) =>
    application.accounts.remove(request),
  );
}
