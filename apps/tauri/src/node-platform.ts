import { dirname } from "node:path";
import { ipcMain, native, sender, send, exitAfterFlush } from "./transport.mjs";
export { ipcMain };
declare const __NEDIA_APP_VERSION__: string;
const root = process.env.NEDIA_TAURI_RUNTIME!;
const userData = process.env.NEDIA_TAURI_DATA!;
if (!root || !userData) throw new Error("Tauri runtime paths are required");
export const app = {
  isPackaged: process.env.NEDIA_TAURI_PACKAGED === "1",
  getPath(name: string) {
    if (name !== "userData") throw new Error(`Unsupported app path: ${name}`);
    return userData;
  },
  getAppPath: () => root,
  getVersion: () => __NEDIA_APP_VERSION__,
  setAsDefaultProtocolClient: () => false,
  relaunch: () => send({ type: "restart" }),
  exit: exitAfterFlush,
};
export const dialog = {
  showOpenDialog: (options: unknown) => native("openDialog", options),
  showSaveDialog: (options: unknown) => native("saveDialog", options),
  showMessageBox: (options: unknown) => native("message", options),
  showErrorBox: (title: string, message: string) => {
    void native("message", { title, message }).catch(() =>
      console.warn(title, message),
    );
  },
};
export const shell = {
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
export const BrowserWindow = {
  getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }],
};
