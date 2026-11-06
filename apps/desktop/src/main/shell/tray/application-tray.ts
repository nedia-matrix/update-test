import { join } from "node:path";

import { app, Menu, nativeImage, Tray } from "electron";

interface ApplicationTrayActions {
  openMainWindow(): void;
  quitApplication(): void;
}

export class ApplicationTray {
  private readonly tray: Tray;

  constructor(actions: ApplicationTrayActions) {
    const iconFilename =
      process.platform === "darwin" ? "mac-tray.png" : "logo.png";
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, iconFilename)
      : join(app.getAppPath(), "../../resources/desktop", iconFilename);
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      throw new Error(`Failed to load tray icon: ${iconPath}`);
    }

    this.tray = new Tray(icon.resize({ width: 20, height: 20 }));
    this.tray.setToolTip("NediaMatrix");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "打开 NediaMatrix",
          click: actions.openMainWindow,
        },
        { type: "separator" },
        {
          label: "退出 NediaMatrix",
          click: actions.quitApplication,
        },
      ]),
    );
    this.tray.on("click", actions.openMainWindow);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
