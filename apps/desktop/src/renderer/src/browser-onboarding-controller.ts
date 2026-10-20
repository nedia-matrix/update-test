import type { MatrixDesktopApi } from "../../bridge/api.js";

export interface BrowserOnboardingState {
  visible: boolean;
  dismissPending: boolean;
  error: string | null;
}

/** Reads startup state once; installation and progress belong to settings. */
export class BrowserOnboardingController {
  private mounted = true;
  private state: BrowserOnboardingState = {
    visible: false,
    dismissPending: false,
    error: null,
  };

  constructor(
    private readonly api: Pick<
      MatrixDesktopApi,
      "getPreferences" | "getFingerprintBrowserStatus" | "updatePreferences"
    >,
    private readonly changed: (state: BrowserOnboardingState) => void,
  ) {}
  snapshot(): BrowserOnboardingState {
    return structuredClone(this.state);
  }
  private publish(patch: Partial<BrowserOnboardingState>) {
    if (!this.mounted) return;
    this.state = { ...this.state, ...patch };
    this.changed(this.snapshot());
  }
  async start() {
    try {
      const [preferences, status] = await Promise.all([
        this.api.getPreferences(),
        this.api.getFingerprintBrowserStatus(),
      ]);
      this.publish({
        visible:
          status.supported &&
          !status.available &&
          !preferences.browser.onboardingDismissed,
      });
    } catch {
      this.publish({ visible: false });
    }
  }
  hide() {
    this.publish({ visible: false });
  }
  async dismiss() {
    if (this.state.dismissPending) return;
    this.publish({ dismissPending: true, error: null });
    try {
      await this.api.updatePreferences({
        browser: { onboardingDismissed: true },
      });
      this.hide();
    } catch {
      this.publish({ error: "保存引导偏好失败，请重试或选择稍后" });
    } finally {
      this.publish({ dismissPending: false });
    }
  }
  dispose() {
    this.mounted = false;
  }
}
