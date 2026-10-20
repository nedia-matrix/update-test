import type { MatrixDesktopApi } from "../../bridge/api.js";
import type { FingerprintBrowserStatus } from "../../bridge/fingerprint-browser.js";
import type { BrowserProvider } from "../../bridge/preferences.js";

export interface BrowserSettingsState {
  status: FingerprintBrowserStatus | null;
  defaultProvider: BrowserProvider | null;
  actionPending: boolean;
  error: string | null;
}
export function isFingerprintTaskActive(
  state: FingerprintBrowserStatus | null,
): boolean {
  return (
    !!state?.taskId &&
    [
      "downloading",
      "checking",
      "extracting",
      "verifying",
      "publishing",
      "cancelling",
    ].includes(state.phase)
  );
}
export class BrowserSettingsController {
  private state: BrowserSettingsState = {
    status: null,
    defaultProvider: null,
    actionPending: false,
    error: null,
  };
  private mounted = true;
  private preferenceRevision = 0;
  private unsubscribe: (() => void) | undefined;
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly api: Pick<
      MatrixDesktopApi,
      | "getPreferences"
      | "updatePreferences"
      | "getFingerprintBrowserStatus"
      | "installFingerprintBrowser"
      | "cancelFingerprintBrowserInstall"
      | "onFingerprintBrowserChanged"
    >,
    private readonly changed: (state: BrowserSettingsState) => void,
  ) {}
  snapshot() {
    return structuredClone(this.state);
  }
  private publish(patch: Partial<BrowserSettingsState>) {
    if (!this.mounted) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.snapshot());
  }
  private accept = (next: FingerprintBrowserStatus) => {
    if (
      !this.mounted ||
      (this.state.status && next.revision < this.state.status.revision)
    )
      return;
    this.publish({ status: next });
    for (const waiter of this.waiters) waiter();
    if (
      next.phase === "ready" &&
      this.state.defaultProvider !== null &&
      !this.state.actionPending
    ) {
      void this.refreshPreferences();
    }
  };
  private async refreshPreferences() {
    const revision = ++this.preferenceRevision;
    try {
      const preferences = await this.api.getPreferences();
      if (revision !== this.preferenceRevision || this.state.actionPending)
        return;
      this.publish({
        defaultProvider: preferences.browser.defaultProvider,
      });
    } catch {
      if (revision === this.preferenceRevision && !this.state.actionPending) {
        this.publish({ error: "读取浏览器偏好失败，请检查偏好文件后重试" });
      }
    }
  }
  async start() {
    this.unsubscribe = this.api.onFingerprintBrowserChanged(this.accept);
    await Promise.all([
      this.refreshPreferences(),
      this.api
        .getFingerprintBrowserStatus()
        .then(this.accept)
        .catch(() => this.publish({ error: "读取定制浏览器状态失败，请重试" })),
    ]);
    // A Main-owned install can finish while a reopened window reads preferences.
    if (this.state.status?.available) await this.refreshPreferences();
  }
  dispose() {
    this.mounted = false;
    this.unsubscribe?.();
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
  private waitForTask(
    taskId: string,
  ): Promise<FingerprintBrowserStatus | null> {
    return new Promise((resolve) => {
      const check = () => {
        const state = this.state.status;
        if (
          !this.mounted ||
          (state?.taskId && state.taskId !== taskId) ||
          (state?.taskId === taskId && !isFingerprintTaskActive(state))
        ) {
          this.waiters.delete(check);
          resolve(this.mounted && state?.taskId === taskId ? state : null);
        }
      };
      this.waiters.add(check);
      check();
    });
  }
  async install() {
    if (this.state.actionPending) return;
    if (!this.state.status?.available) return this.setDefault("fingerprint");
    this.publish({ error: null });
    try {
      this.accept(await this.api.installFingerprintBrowser());
    } catch {
      this.publish({ error: "启动定制浏览器安装失败，请重试" });
    }
  }
  async cancel() {
    const taskId = this.state.status?.taskId;
    if (!taskId) return;
    try {
      this.accept(await this.api.cancelFingerprintBrowserInstall({ taskId }));
    } catch {
      this.publish({ error: "取消安装失败，请重试" });
    }
  }
  async setDefault(provider: BrowserProvider) {
    if (this.state.actionPending || this.state.defaultProvider === null) return;
    ++this.preferenceRevision;
    if (
      this.state.defaultProvider === provider &&
      (provider !== "fingerprint" || this.state.status?.available)
    )
      return;
    this.publish({ actionPending: true, error: null });
    try {
      if (provider === "fingerprint" && !this.state.status?.available) {
        const started = await this.api.installFingerprintBrowser({
          enableForNewAccounts: true,
        });
        this.accept(started);
        if (!started.taskId) {
          this.publish({
            error: started.error?.message ?? "定制浏览器尚未就绪",
          });
          return;
        }
        const result = await this.waitForTask(started.taskId);
        if (!result || result.phase === "cancelled") return;
        if (result.phase !== "ready") {
          this.publish({
            error: result.error?.message ?? "定制浏览器尚未就绪",
          });
          return;
        }
        if (!this.mounted) return;
        // Main owns the install-and-enable intent even if the window is closed.
        const prepared = await this.api.getPreferences();
        if (prepared.browser.defaultProvider === "fingerprint") {
          this.publish({ defaultProvider: "fingerprint" });
          return;
        }
      }
      if (!this.mounted) return;
      const saved = await this.api.updatePreferences({
        browser: { defaultProvider: provider },
      });
      this.publish({ defaultProvider: saved.browser.defaultProvider });
    } catch {
      this.publish({ error: "准备或保存浏览器偏好失败，请重试" });
    } finally {
      this.publish({ actionPending: false });
    }
  }
}
