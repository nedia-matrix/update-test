import type { AutomationNotice } from "@nedia-matrix/desktop-runtime/application/automation-notice";
import type { RuntimeShell } from "@nedia-matrix/desktop-runtime/runtime/runtime-host";
import { ipcChannels } from "@nedia-matrix/desktop-contracts/channels";
import { automationNoticeMessages } from "@nedia-matrix/desktop-runtime/application/automation-notice";
import { native, sender } from "./transport.mjs";
class TauriMainWindow {
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
class TauriAutomationNotices {
  constructor(
    private readonly report?: Parameters<RuntimeShell["createNotices"]>[0],
  ) {}
  show(notice: AutomationNotice) {
    const text = automationNoticeMessages[notice.kind];
    this.report?.(notice, "notice.opening");
    void native("message", {
      title: text.title,
      message: ["message" in notice ? notice.message : undefined, text.body]
        .filter(Boolean)
        .join("\n"),
    })
      .then(() => this.report?.(notice, "notice.shown"))
      .catch((error) => this.report?.(notice, "notice.failed", error));
  }
}

export const tauriShell: RuntimeShell = {
  createMainWindow: () => new TauriMainWindow(),
  createNotices: (report) => new TauriAutomationNotices(report),
  // Rust owns the native menu and tray, and disposes them with the GUI process.
  start: () => ({ destroy() {} }),
  showApplication() {},
  registerProtocol() {},
};
