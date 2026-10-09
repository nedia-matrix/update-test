import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ipcChannels } from "../../../bridge/channels.js";
import type { PublishResultUpdate } from "@nedia-matrix/publishing";
import { BrowserWindow } from "electron";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export class ElectronMainWindow {
  private window: BrowserWindow | undefined;

  constructor(private readonly onLoadFailure?: (error: unknown) => void) {}

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    const window = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 860,
      minHeight: 560,
      show: true,
      title: "NediaMatrix",
      webPreferences: {
        preload: join(currentDirectory, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = window;
    window.once("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    const loading = rendererUrl
      ? window.loadURL(rendererUrl)
      : window.loadFile(join(currentDirectory, "../renderer/index.html"));
    void loading
      .catch((error: unknown) => {
        try {
          this.onLoadFailure?.(error);
        } catch {
          // Diagnostics must not interfere with window recovery.
        }
        console.error("Failed to load the desktop renderer", error);
      })
      .finally(() => {
        if (window.isDestroyed()) return;
        window.show();
        window.focus();
      });
  }

  sendPublishResult(update: PublishResultUpdate): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(ipcChannels.publishResultUpdate, update);
  }

  sendAccountsChanged(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(ipcChannels.platformAccountsChanged);
  }
}
