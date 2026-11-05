import { ipcChannels } from "../../desktop/src/bridge/channels.js";
import { automationNoticeMessages } from "../../desktop/src/main/application/automation-notice.js";
import { native, sender } from "./transport.mjs";
export class ElectronMainWindow {
  constructor(..._callbacks: unknown[]) {}
  open() {
    void native("showWindow").catch(() => undefined);
  }
  sendTasksChanged() {
    sender.send(ipcChannels.tasksChanged);
  }
  sendPublishResult(value: unknown) {
    sender.send(ipcChannels.publishResultUpdate, value);
  }
  sendAccountBrowserRuntimesChanged(value: unknown) {
    sender.send(ipcChannels.accountBrowserRuntimesChanged, value);
  }
  sendAccountsChanged() {
    sender.send(ipcChannels.platformAccountsChanged);
  }
}
// shortcut: reuse desktop startup through build-time adapters; the shell-specific native adapters stay in apps/tauri/src.
// Native shell owns its own menu and tray.
export function installApplicationMenu() {}
export class ApplicationTray {
  destroy() {}
}
export class ElectronAutomationNotices {
  constructor(private readonly report?: (...args: unknown[]) => void) {}
  show(notice: {
    kind: keyof typeof automationNoticeMessages;
    message?: string;
  }) {
    const text = automationNoticeMessages[notice.kind];
    this.report?.(notice, "notice.opening");
    void native("message", {
      title: text.title,
      message: [notice.message, text.body].filter(Boolean).join("\n"),
    })
      .then(() => this.report?.(notice, "notice.shown"))
      .catch((error) => this.report?.(notice, "notice.failed", error));
  }
}
