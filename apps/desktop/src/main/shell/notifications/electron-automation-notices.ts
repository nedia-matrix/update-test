import { BrowserWindow, dialog } from "electron";

import {
  automationNoticeMessages,
  type AutomationNotice,
  type AutomationNoticeSink,
} from "../../application/automation-notice.js";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

export class ElectronAutomationNotices implements AutomationNoticeSink {
  private readonly windows = new Map<string, BrowserWindow>();

  constructor(
    private readonly closeAccountBrowser: (accountId: string) => Promise<void>,
    private readonly report?: (
      notice: AutomationNotice,
      event: "notice.opening" | "notice.shown" | "notice.failed",
      error?: unknown,
    ) => void,
  ) {}

  show(notice: AutomationNotice): void {
    const message = automationNoticeMessages[notice.kind];
    const body = [
      notice.kind.startsWith("publish.") &&
      "message" in notice &&
      notice.message
        ? `原因：${notice.message}`
        : null,
      message.body,
      notice.kind.startsWith("publish.") &&
      "pageAvailable" in notice &&
      notice.pageAvailable
        ? "发布页面已保留，可在其中检查内容和平台提示。"
        : null,
      notice.kind === "publish.preparation_failed" && !notice.pageAvailable
        ? "发布页未能保留，请在应用中查看失败记录。"
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    const showFallback = (title: string, text: string) => {
      void dialog
        .showMessageBox({ type: "warning", title, message: text })
        .catch((error: unknown) =>
          console.error("Failed to display fallback notice", error),
        );
    };
    const report = (
      event: "notice.opening" | "notice.shown" | "notice.failed",
      error?: unknown,
    ) => {
      try {
        this.report?.(notice, event, error);
      } catch {
        // Logging must not prevent an application notice.
      }
    };
    report("notice.opening");
    // A later publishing notice supersedes any old browser-close prompt.
    this.windows.get(notice.accountId)?.close();
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        width: 460,
        height: 260,
        show: false,
        title: "NediaMatrix",
        resizable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
    } catch (error) {
      report("notice.failed", error);
      showFallback(message.title, body);
      return;
    }
    this.windows.set(notice.accountId, window);
    window.on("closed", () => {
      if (this.windows.get(notice.accountId) === window)
        this.windows.delete(notice.accountId);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let handling = false;
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (handling) return;
      if (url === "https://notice.invalid/dismiss") {
        window.close();
      } else if (
        url === "https://notice.invalid/close" &&
        notice.kind === "account.synced"
      ) {
        handling = true;
        void this.closeAccountBrowser(notice.accountId)
          .then(() => {
            if (!window.isDestroyed()) window.close();
          })
          .catch((error: unknown) => {
            handling = false;
            console.error("Failed to close account browser", error);
            void render(
              "暂时无法关闭窗口",
              "账号可能正在发布。请保留浏览器，待任务结束后再关闭。",
              false,
            );
          });
      }
    });
    const render = async (title: string, body: string, canClose: boolean) => {
      if (window.isDestroyed()) return;
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>:root{color-scheme:light dark}body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:24px;color:light-dark(#202124,#eee);background:light-dark(#fff,#252525)}h1{font-size:19px;margin:0 0 14px}p{line-height:1.7;margin:0;white-space:pre-line}footer{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}a{padding:9px 16px;border-radius:7px;text-decoration:none;color:inherit;border:1px solid #888}a:last-child{background:#2864dc;border-color:#2864dc;color:white}a:focus-visible{outline:3px solid #87adff;outline-offset:2px}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><footer>${canClose ? '<a href="https://notice.invalid/close">关闭窗口</a>' : ""}<a href="https://notice.invalid/dismiss" autofocus>${canClose ? "保留窗口" : "知道了"}</a></footer></html>`;
      try {
        await window.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
        );
        if (!window.isDestroyed()) {
          window.show();
          report("notice.shown");
        }
      } catch (error) {
        console.error("Failed to display automation notice window", error);
        report("notice.failed", error);
        if (!window.isDestroyed()) window.close();
        showFallback(title, body);
      }
    };
    void render(message.title, body, notice.kind === "account.synced");
  }
}
