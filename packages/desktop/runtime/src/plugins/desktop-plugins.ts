import {
  resolvePluginEnvironment,
  type PluginEnvironment,
} from "./plugin-environment.js";
import { configuredRuntimePaths } from "../runtime/runtime-paths.js";
import { businessDataDirectory } from "../runtime/desktop-data-paths.js";
import { recordApplicationUpdateStartup } from "../updates/desktop-application-update.js";
import { app, dialog, ipcMain } from "../runtime/runtime-host.js";
import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { PlatformPluginManager } from "./plugin-manager.js";
import { desktopPlatformCatalog } from "../platforms/platform-registry.js";
import { ipcChannels } from "@nedia-matrix/desktop-contracts/channels";
import type { PlatformPluginChange } from "@nedia-matrix/desktop-contracts/plugins";
import { maxPluginBytes } from "./plugin-package.js";

declare const __NEDIA_UPDATE_PUBLIC_KEYS__: Record<string, string>;
let manager: PlatformPluginManager | undefined;
export function desktopPlugins(): PlatformPluginManager {
  if (!manager) throw new Error("平台插件尚未初始化");
  return manager;
}
export async function initializeDesktopPlugins(
  environment?: PluginEnvironment,
  assertAcceptingCommands: () => void = () => {},
): Promise<void> {
  const selected = resolvePluginEnvironment(
    environment ??
      (app.isPackaged || configuredRuntimePaths()?.environment === "development"
        ? {
            trust: "release",
            bundledDirectory: join(app.resourcesDirectory, "plugins"),
            publicKeys:
              typeof __NEDIA_UPDATE_PUBLIC_KEYS__ !== "undefined"
                ? __NEDIA_UPDATE_PUBLIC_KEYS__
                : {},
          }
        : {
            trust: "development",
            bundledDirectory: join(
              app.resourcesDirectory,
              "plugins-development",
            ),
          }),
  );
  const bundled = selected.bundledDirectory;
  // Persist the migration boundary before plugin construction or preinstall writes.
  if (selected.trust === "release") await recordApplicationUpdateStartup(false);
  manager = new PlatformPluginManager(
    join(businessDataDirectory(), selected.installationDirectoryName),
    selected.publicKeys,
  );
  try {
    manager.preinstall(bundled);
  } catch (error) {
    console.error("平台插件预装失败", error);
    manager.reportPreinstallFailure();
  }
  if (selected.refreshBundledOnStartup) {
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
  ipcMain.handle(ipcChannels.listBundledPlugins, () =>
    desktopPlugins().listBundled(bundled),
  );
  ipcMain.handle(ipcChannels.installBundledPlugin, (_event, id: string) => {
    assertAcceptingCommands();
    return desktopPlugins().stageBundledInstall(bundled, id);
  });
  ipcMain.handle(
    ipcChannels.changePlugin,
    (_event, change: PlatformPluginChange) => {
      assertAcceptingCommands();
      return desktopPlugins().stageChange(change);
    },
  );
  ipcMain.handle(ipcChannels.installPlugin, async () => {
    assertAcceptingCommands();
    const selection = await dialog.showOpenDialog({
      title: "安装平台插件",
      properties: ["openFile"],
      filters: [{ name: "平台插件包", extensions: ["nmp"] }],
    });
    assertAcceptingCommands();
    if (selection.canceled || !selection.filePaths[0])
      return desktopPlugins().list();
    const path = selection.filePaths[0],
      info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxPluginBytes)
      throw new Error("插件包文件无效或过大");
    return desktopPlugins().stageInstall(readFileSync(path));
  });
}
