import { BrowserWindow, ipcMain } from "electron";
import { ipcChannels } from "../../bridge/channels.js";
import type {
  InstallFingerprintBrowserRequest,
  CancelFingerprintBrowserInstallRequest,
} from "../../bridge/fingerprint-browser.js";
import type { FingerprintBrowserService } from "./fingerprint-browser-service.js";

export function registerFingerprintBrowserIpc(
  service: FingerprintBrowserService,
): void {
  ipcMain.handle(ipcChannels.getFingerprintBrowserStatus, () =>
    service.getStatus(),
  );
  // No paths, download URLs or process arguments are accepted from the Renderer.
  ipcMain.handle(
    ipcChannels.installFingerprintBrowser,
    (_event, request?: InstallFingerprintBrowserRequest) => {
      if (
        request?.enableForNewAccounts !== undefined &&
        typeof request.enableForNewAccounts !== "boolean"
      ) {
        throw new TypeError("Invalid browser installation preference");
      }
      return request?.enableForNewAccounts
        ? service.install({ enableForNewAccounts: true })
        : service.install();
    },
  );
  ipcMain.handle(
    ipcChannels.cancelFingerprintBrowserInstall,
    (_event, request: CancelFingerprintBrowserInstallRequest) =>
      service.cancel(request),
  );
  service.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(ipcChannels.fingerprintBrowserChanged, state);
    }
  });
}
