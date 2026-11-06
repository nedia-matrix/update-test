import { configureTauriRuntimeHost } from "./runtime-host.js";
import { tauriPluginEnvironment } from "./plugin-environment.js";
import { prepareRuntimeCompatibility } from "@nedia-matrix/desktop-runtime/runtime/runtime-compatibility";
import {
  configureRuntimePaths,
  electronUserDataDirectory,
} from "@nedia-matrix/desktop-runtime/runtime/runtime-paths";
import { join } from "node:path";
import { acquireRuntimeLock } from "@nedia-matrix/desktop-runtime/runtime/runtime-lock";
import { Console } from "node:console";
import { registerRendererStartup } from "./startup-confirmation.mjs";
import { ipcMain, markReady, send, serve } from "./transport.mjs";
// Reserve stdout before loading any business dependency.
globalThis.console = new Console(process.stderr, process.stderr);
configureTauriRuntimeHost();
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
    await import("@nedia-matrix/desktop-runtime/plugins/desktop-plugins");
  const { desktopPreferences } =
    await import("@nedia-matrix/desktop-runtime/preferences/desktop-preferences");
  const { registerPreferencesIpc } =
    await import("@nedia-matrix/desktop-runtime/preferences/register-preferences-ipc");
  const { DesktopRuntime } =
    await import("@nedia-matrix/desktop-runtime/bootstrap/desktop-runtime");
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
    await import("@nedia-matrix/desktop-runtime/updates/desktop-application-update");
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
