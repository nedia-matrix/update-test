import {
  prepareRuntimeCompatibility,
  RuntimeCompatibilityError,
} from "../runtime/runtime-compatibility.js";
import { configureRuntimePaths } from "../runtime/runtime-paths.js";
import { join } from "node:path";
import {
  acquireRuntimeLock,
  RuntimeInUseError,
} from "../runtime/runtime-lock.js";
import { initializeDesktopPlugins } from "../plugins/desktop-plugins.js";
import { desktopPreferences } from "../preferences/desktop-preferences.js";
import { registerPreferencesIpc } from "../preferences/register-preferences-ipc.js";
import {
  assertUpdateSourceIdle,
  updateSourceChanged,
} from "../updates/electron-application-update.js";
import { app, dialog } from "electron";

import {
  findNediaMatrixOpenUrl,
  isNediaMatrixOpenUrl,
} from "../shell/protocol/custom-protocol.js";
import {
  DesktopRuntime,
  flushStartupFailureDiagnostics,
} from "./desktop-runtime.js";
import { waitForShutdown } from "./runtime-cleanup.js";

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
          : join(app.getAppPath(), "resources"),
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
      "本地数据恢复失败",
      "应用未能完成启动，业务入口尚未开放。请退出后重新启动以重试；若问题持续，请保留本地数据并联系支持。请勿重复发布。",
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
