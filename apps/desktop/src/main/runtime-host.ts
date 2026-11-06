import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { configureRuntimeHost } from "@nedia-matrix/desktop-runtime/runtime/runtime-host";
import { ElectronMainWindow } from "./shell/window/electron-main-window.js";
import { ElectronAutomationNotices } from "./shell/notifications/electron-automation-notices.js";
import { ApplicationTray } from "./shell/tray/application-tray.js";
import { installApplicationMenu } from "./shell/menu/application-menu.js";
import { NEDIA_MATRIX_PROTOCOL } from "./shell/protocol/custom-protocol.js";

declare const __NEDIA_UPDATE_DISTRIBUTION__: string;
export function configureElectronRuntimeHost(): void {
  configureRuntimeHost({
    app: {
      get isPackaged() {
        return app.isPackaged;
      },
      getVersion: () => app.getVersion(),
      getPath: (name) => app.getPath(name),
      get resourcesDirectory() {
        return app.isPackaged
          ? process.resourcesPath
          : path.resolve(app.getAppPath(), "../../resources/desktop");
      },
      relaunch: (options) => app.relaunch(options),
      exit: (code) => app.exit(code),
    },
    dialog,
    shell,
    ipcMain,
    broadcast(channel, ...args) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send(channel, ...args);
      }
    },
    desktopShell: {
      createMainWindow: (failure, success) =>
        new ElectronMainWindow(failure, success),
      createNotices: (report) => new ElectronAutomationNotices(report),
      start(actions) {
        installApplicationMenu(actions);
        return new ApplicationTray(actions);
      },
      showApplication() {
        if (process.platform !== "darwin") return;
        const dock = app.dock;
        if (dock && !dock.isVisible())
          void dock
            .show()
            .catch((error: unknown) =>
              console.error(
                "Failed to show the application in the Dock",
                error,
              ),
            );
      },
      registerProtocol() {
        const registered =
          process.defaultApp && process.argv[1]
            ? app.setAsDefaultProtocolClient(
                NEDIA_MATRIX_PROTOCOL,
                process.execPath,
                [path.resolve(process.argv[1])],
              )
            : app.setAsDefaultProtocolClient(NEDIA_MATRIX_PROTOCOL);
        if (!registered)
          console.warn("Failed to register nedia-matrix protocol handler");
      },
    },
    installationContext: () => ({
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
    }),
  });
}
