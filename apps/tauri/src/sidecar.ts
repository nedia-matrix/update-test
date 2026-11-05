import { tauriPluginEnvironment } from "./plugin-environment.js";
import { prepareRuntimeCompatibility } from "../../desktop/src/main/runtime/runtime-compatibility.js";
import {
  configureRuntimePaths,
  electronUserDataDirectory,
} from "../../desktop/src/main/runtime/runtime-paths.js";
import { join } from "node:path";
import { acquireRuntimeLock } from "../../desktop/src/main/runtime/runtime-lock.js";
import { Console } from "node:console";
import { registerRendererStartup } from "./startup-confirmation.mjs";
import { ipcMain, markReady, send, serve } from "./transport.mjs";
// Reserve stdout before loading any business dependency.
globalThis.console = new Console(process.stderr, process.stderr);
let runtime:
  { requestQuit(): void; assertAcceptingCommands(): void } | undefined;
serve(() =>
  runtime ? runtime.requestQuit() : process.exit(Number(process.exitCode ?? 0)),
);
try {
  const sharedUserData =
    process.env.NEDIA_TAURI_SHARED_USER_DATA === "1" &&
    !process.env.NEDIA_COEXISTENCE_TEST_ROOT;
  const plugins = tauriPluginEnvironment(
    process.env.NEDIA_TAURI_RUNTIME!,
    sharedUserData,
  );
  const paths = configureRuntimePaths({
    shell: "tauri",
    environment: sharedUserData
      ? process.env.NEDIA_TAURI_PACKAGED === "1"
        ? "production"
        : "development"
      : "prototype",
    ...(sharedUserData
      ? {
          sharedDirectory: electronUserDataDirectory(
            process.env.NEDIA_ELECTRON_APP_DATA!,
          ),
        }
      : {}),
    legacyDirectory:
      plugins.trust === "release" && !sharedUserData
        ? join(process.env.NEDIA_TAURI_DATA!, "signed-trust")
        : process.env.NEDIA_TAURI_DATA!,
    testRoot: process.env.NEDIA_COEXISTENCE_TEST_ROOT,
  });
  if (
    process.env.MATRIX_RUNTIME_PORT === undefined &&
    paths.environment === "prototype"
  ) {
    process.env.MATRIX_RUNTIME_PORT = "0";
  }
  acquireRuntimeLock(
    paths.businessDirectory,
    join(
      process.env.NEDIA_TAURI_RUNTIME!,
      "native",
      `${process.platform}-${process.arch}`,
    ),
  );
  prepareRuntimeCompatibility(
    paths.businessDirectory,
    plugins.trust === "release" ? "plugins" : "plugins-development",
  );
  const { initializeDesktopPlugins } =
    await import("../../desktop/src/main/plugins/desktop-plugins.js");
  const { desktopPreferences } =
    await import("../../desktop/src/main/preferences/desktop-preferences.js");
  const { registerPreferencesIpc } =
    await import("../../desktop/src/main/preferences/register-preferences-ipc.js");
  const { DesktopRuntime } =
    await import("../../desktop/src/main/bootstrap/desktop-runtime.js");
  await initializeDesktopPlugins(plugins, () =>
    runtime?.assertAcceptingCommands(),
  );
  const desktop = new DesktopRuntime();
  runtime = desktop;
  registerPreferencesIpc(
    desktopPreferences(),
    undefined,
    () => desktop.assertFingerprintBrowserReady(),
    () => desktop.assertAcceptingCommands(),
  );
  desktop.start();
  const { recordApplicationUpdateStartup } =
    await import("../../desktop/src/main/updates/electron-application-update.js");
  registerRendererStartup(ipcMain, desktop, () =>
    recordApplicationUpdateStartup(true),
  );
  markReady();
} catch (error) {
  console.error(error);
  send({
    type: "fatal",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  process.stdin.destroy();
}
