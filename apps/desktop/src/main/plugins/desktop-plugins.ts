import { recordApplicationUpdateStartup } from "../updates/electron-application-update.js";
import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { PlatformPluginManager } from "./plugin-manager.js";
import { desktopPlatformCatalog } from "../platforms/platform-registry.js";
import { ipcChannels } from "../../bridge/channels.js";
import type { PlatformPluginChange } from "../../bridge/plugins.js";
import { maxPluginBytes } from "./plugin-package.js";

declare const __NEDIA_UPDATE_PUBLIC_KEYS__: Record<string, string>;
let manager: PlatformPluginManager | undefined;
export function desktopPlugins(): PlatformPluginManager {
  if (!manager) throw new Error("平台插件尚未初始化");
  return manager;
}
export async function initializeDesktopPlugins(): Promise<void> {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, "plugins")
    : join(app.getAppPath(), ".plugins-development");
  // Development trust is loaded only in unpackaged mode, never into a distributed binary.
  const keys = app.isPackaged
    ? typeof __NEDIA_UPDATE_PUBLIC_KEYS__ !== "undefined"
      ? __NEDIA_UPDATE_PUBLIC_KEYS__
      : {}
    : (JSON.parse(
        readFileSync(join(bundled, "development-public-keys.json"), "utf8"),
      ) as Record<string, string>);
  manager = new PlatformPluginManager(
    join(
      app.getPath("userData"),
      app.isPackaged ? "plugins" : "plugins-development",
    ),
    keys,
  );
  try {
    manager.preinstall(bundled);
  } catch (error) {
    console.error("平台插件预装失败", error);
    manager.reportPreinstallFailure();
  }
  if (!app.isPackaged) {
    // Adopt rebuilt development packages before importing execution entries.
    manager.stageBundledUpdate(bundled);
  } else {
    await recordApplicationUpdateStartup(false, () => {
      try {
        desktopPlugins().stageBundledUpdate(bundled);
      } catch {
        desktopPlugins().reportUpdateFailure();
      }
    });
  }
  desktopPlatformCatalog.replace(await manager.load());
  desktopPlatformCatalog.setUnavailable(
    manager
      .list()
      .filter((item) => !item.available)
      .map((item) => ({
        id: item.platformId,
        displayName: item.displayName,
        iconUrl: item.iconUrl,
        reason:
          item.error ??
          (!item.installed
            ? "插件未安装"
            : !item.enabled
              ? "插件已停用"
              : "插件不可用"),
      })),
  );
  ipcMain.handle(ipcChannels.listPlugins, () => {
    const plugins = desktopPlugins();
    if (plugins.initializationError())
      throw new Error(plugins.initializationError());
    return plugins.list();
  });
  ipcMain.handle(
    ipcChannels.changePlugin,
    (_event, change: PlatformPluginChange) =>
      desktopPlugins().stageChange(change),
  );
  ipcMain.handle(ipcChannels.installPlugin, async () => {
    const selection = await dialog.showOpenDialog({
      title: "安装平台插件",
      properties: ["openFile"],
      filters: [{ name: "平台插件包", extensions: ["nmp"] }],
    });
    if (selection.canceled || !selection.filePaths[0])
      return desktopPlugins().list();
    const path = selection.filePaths[0],
      info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxPluginBytes)
      throw new Error("插件包文件无效或过大");
    return desktopPlugins().stageInstall(readFileSync(path));
  });
}
