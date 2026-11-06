import { tauriInstallationContext } from "./installation-context.js";
import { dirname } from "node:path";
import { ipcMain, native, sender, send, exitAfterFlush } from "./transport.mjs";
import { configureRuntimeHost } from "@nedia-matrix/desktop-runtime/runtime/runtime-host";
import { tauriShell } from "./shell.js";
import type { RuntimeDialogs } from "@nedia-matrix/desktop-runtime/runtime/runtime-host";

declare const __NEDIA_APP_VERSION__: string;
const root = process.env.NEDIA_TAURI_RUNTIME!;
const userData = process.env.NEDIA_TAURI_DATA!;
if (!root || !userData) throw new Error("Tauri runtime paths are required");
const app = {
  resourcesDirectory: root,
  isPackaged: process.env.NEDIA_TAURI_PACKAGED === "1",
  getPath(name: string) {
    if (name !== "userData") throw new Error(`Unsupported app path: ${name}`);
    return userData;
  },
  getVersion: () => __NEDIA_APP_VERSION__,
  relaunch: (_options: { execPath?: string }) => send({ type: "restart" }),
  exit: exitAfterFlush,
};
const dialog: RuntimeDialogs = {
  showOpenDialog: (options) => native("openDialog", options),
  showSaveDialog: (options) => native("saveDialog", options),
  showMessageBox: (options) => native("message", options),
  showErrorBox: (title: string, message: string) => {
    void native("message", { title, message }).catch(() =>
      console.warn(title, message),
    );
  },
};
const shell = {
  showItemInFolder: (file: string) =>
    native("openPath", { path: dirname(file) }),
  trashItem: async (file: string): Promise<void> => {
    await native("trashItem", { path: file });
  },
  openExternal: (url: string) => native("openExternal", { url }),
  openPath: async (path: string) => {
    await native("openPath", { path });
    return "";
  },
};
export function configureTauriRuntimeHost(): void {
  configureRuntimeHost({
    app,
    dialog,
    shell,
    ipcMain,
    broadcast: (channel, ...args) => sender.send(channel, ...args),
    desktopShell: tauriShell,
    installationContext: tauriInstallationContext,
  });
}
