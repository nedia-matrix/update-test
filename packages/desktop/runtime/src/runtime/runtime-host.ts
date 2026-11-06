import type { AccountBrowserRuntime } from "@nedia-matrix/desktop-contracts/account-browser-runtime";
import type { PublishResultUpdate } from "@nedia-matrix/publishing";
import type {
  AutomationNotice,
  AutomationNoticeSink,
} from "../application/automation-notice.js";
import type { InstallContext } from "../updates/update-installation.js";

export interface RuntimeSender {
  isDestroyed(): boolean;
  send(channel: string, ...args: any[]): void;
}
export interface RuntimeCommands {
  handle(
    channel: string,
    handler: (event: { sender: RuntimeSender }, ...args: any[]) => any,
  ): void;
}
interface FileFilter {
  name: string;
  extensions: string[];
}
export interface RuntimeDialogs {
  showOpenDialog(options: {
    title?: string;
    properties?: Array<"openFile" | "multiSelections">;
    filters?: FileFilter[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(options: {
    title?: string;
    defaultPath?: string;
    filters?: FileFilter[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
  showMessageBox(options: {
    type?: "warning" | "error" | "info";
    title?: string;
    message: string;
    detail?: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
  }): Promise<{ response: number }>;
  showErrorBox(title: string, message: string): void;
}
export interface RuntimeMainWindow {
  open(): void;
  sendTasksChanged(): void;
  sendPublishResult(update: PublishResultUpdate): void;
  sendAccountBrowserRuntimesChanged(runtimes: AccountBrowserRuntime[]): void;
  sendAccountsChanged(): void;
}
export interface RuntimeShell {
  createMainWindow(
    onFailure: (error: unknown) => void,
    onSuccess: () => void,
  ): RuntimeMainWindow;
  createNotices(
    report: (
      notice: AutomationNotice,
      event: "notice.opening" | "notice.shown" | "notice.failed",
      error?: unknown,
    ) => void,
  ): AutomationNoticeSink;
  start(actions: { openMainWindow(): void; quitApplication(): void }): {
    destroy(): void;
  };
  showApplication(): void;
  registerProtocol(): void;
}
export interface RuntimeHost {
  app: {
    isPackaged: boolean;
    getVersion(): string;
    getPath(name: "userData"): string;
    resourcesDirectory: string;
    relaunch(options: { execPath?: string }): void;
    exit(code: number): void;
  };
  dialog: RuntimeDialogs;
  shell: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void | Promise<void>;
    trashItem(path: string): Promise<void>;
  };
  ipcMain: RuntimeCommands;
  broadcast(channel: string, ...args: any[]): void;
  desktopShell: RuntimeShell;
  installationContext(): Omit<InstallContext, "userData" | "currentVersion">;
}

// One business runtime owns this process; configure its host before loading services.
export let app: RuntimeHost["app"];
export let dialog: RuntimeHost["dialog"];
export let shell: RuntimeHost["shell"];
export let ipcMain: RuntimeCommands;
export let broadcast: RuntimeHost["broadcast"];
export let desktopShell: RuntimeShell;
export let hostInstallationContext: RuntimeHost["installationContext"];
export function configureRuntimeHost(host: RuntimeHost): void {
  ({
    app,
    dialog,
    shell,
    ipcMain,
    broadcast,
    desktopShell,
    installationContext: hostInstallationContext,
  } = host);
}
