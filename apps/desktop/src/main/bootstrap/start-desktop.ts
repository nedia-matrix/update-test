import {
  prepareRuntimeCompatibility,
  RuntimeCompatibilityError,
} from "@nedia-matrix/desktop-runtime/runtime/runtime-compatibility";
import { configureRuntimePaths } from "@nedia-matrix/desktop-runtime/runtime/runtime-paths";
import { join } from "node:path";
import {
  acquireRuntimeLock,
  RuntimeInUseError,
} from "@nedia-matrix/desktop-runtime/runtime/runtime-lock";
import { MetadataMaintenanceError } from "@nedia-matrix/metadata-maintenance";
import { initializeDesktopPlugins } from "@nedia-matrix/desktop-runtime/plugins/desktop-plugins";
import { desktopPreferences } from "@nedia-matrix/desktop-runtime/preferences/desktop-preferences";
import { registerPreferencesIpc } from "@nedia-matrix/desktop-runtime/preferences/register-preferences-ipc";
import {
  assertUpdateSourceIdle,
  updateSourceChanged,
} from "@nedia-matrix/desktop-runtime/updates/desktop-application-update";
import { app, dialog } from "electron";

import {
  findNediaMatrixOpenUrl,
  isNediaMatrixOpenUrl,
} from "../shell/protocol/custom-protocol.js";
import {
  DesktopRuntime,
  flushStartupFailureDiagnostics,
} from "@nedia-matrix/desktop-runtime/bootstrap/desktop-runtime";
import { waitForShutdown } from "@nedia-matrix/desktop-runtime/bootstrap/runtime-cleanup";

let desktopRuntime: DesktopRuntime | undefined;

function acceptOpenUrl(value: string): void {
  if (!isNediaMatrixOpenUrl(value)) {
    console.warn("Ignored invalid nedia-matrix protocol URL");
    return;
  }
  desktopRuntime?.openMainWindow();
}

app.on("open-url", (event, value) => {
  event.preventDefault();
  acceptOpenUrl(value);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, commandLine) => {
    const openUrl = findNediaMatrixOpenUrl(commandLine);
    if (openUrl) acceptOpenUrl(openUrl);
    desktopRuntime?.openMainWindow();
  });
}

void (hasSingleInstanceLock ? app.whenReady() : Promise.resolve())
  .then(async () => {
    if (!hasSingleInstanceLock) return;
    const paths = configureRuntimePaths({
      shell: "electron",
      environment: app.isPackaged ? "production" : "development",
      legacyDirectory: app.getPath("userData"),
      testRoot: process.env.NEDIA_COEXISTENCE_TEST_ROOT,
    });
    acquireRuntimeLock(
      paths.businessDirectory,
      join(
        app.isPackaged
          ? process.resourcesPath
          : join(app.getAppPath(), "../../resources/desktop"),
        "native",
        `${process.platform}-${process.arch}`,
      ),
    );
    prepareRuntimeCompatibility(
      paths.businessDirectory,
      paths.environment === "coexistence-test" && !app.isPackaged
        ? "plugins-development"
        : "plugins",
    );
    registerPreferencesIpc(
      desktopPreferences(),
      {
        assertIdle: assertUpdateSourceIdle,
        changed: updateSourceChanged,
      },
      () => {
        if (!desktopRuntime) throw new Error("浏览器服务尚未就绪");
        return desktopRuntime.assertFingerprintBrowserReady();
      },
      () => desktopRuntime?.assertAcceptingCommands(),
    );
    await initializeDesktopPlugins(undefined, () =>
      desktopRuntime?.assertAcceptingCommands(),
    );
    desktopRuntime = new DesktopRuntime();
    desktopRuntime.start();
    const initialOpenUrl = findNediaMatrixOpenUrl(process.argv);
    if (initialOpenUrl) acceptOpenUrl(initialOpenUrl);
    desktopRuntime.openMainWindow();
    app.on("activate", () => desktopRuntime?.openMainWindow());
  })
  .catch(async (error: unknown) => {
    if (error instanceof RuntimeCompatibilityError) {
      dialog.showErrorBox("数据版本不兼容", error.message);
      app.exit(1);
      return;
    }
    if (error instanceof RuntimeInUseError) {
      dialog.showErrorBox("业务运行中", error.message);
      app.exit(1);
      return;
    }
    // The constructor may have logged a SQLite failure before it could return.
    // Give the bounded file queue a chance to persist that record before exit.
    await waitForShutdown(
      flushStartupFailureDiagnostics().catch(() => undefined),
      2_000,
    );
    console.error(
      "Failed to initialize Electron",
      error instanceof Error ? error.name : "UnknownError",
    );
    dialog.showErrorBox(
      error instanceof MetadataMaintenanceError
        ? "本地数据库暂不可用"
        : "本地数据恢复失败",
      error instanceof MetadataMaintenanceError
        ? "数据库正在使用、维护或存在未完成恢复。请保持应用退出，在 DevTools 中完成恢复或退回原库后重试。请勿手动删除恢复阶段记录。"
        : "应用未能完成启动，业务入口尚未开放。请退出后重新启动以重试；若问题持续，请保留本地数据并联系支持。请勿重复发布。",
    );
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform === "darwin") app.dock?.hide();
});

app.on("before-quit", (event) => {
  if (!desktopRuntime || desktopRuntime.canQuit) return;
  event.preventDefault();
  desktopRuntime.requestQuit();
});
