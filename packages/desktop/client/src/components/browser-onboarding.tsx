import { useEffect, useRef, useState } from "preact/hooks";
import {
  BrowserOnboardingController,
  type BrowserOnboardingState,
} from "../browser-onboarding-controller.js";
import { browserSettingsHash } from "../browser-settings-navigation.js";

export function BrowserOnboarding() {
  const [state, setState] = useState<BrowserOnboardingState | null>(null);
  const controller = useRef<BrowserOnboardingController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const instance = new BrowserOnboardingController(window.matrix, setState);
    controller.current = instance;
    void instance.start();
    return () => {
      instance.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    if (state?.visible && !dialog.current?.open) dialog.current?.showModal();
    else if (!state?.visible) dialog.current?.close();
  }, [state?.visible]);
  return (
    <dialog
      ref={dialog}
      class="browser-onboarding"
      aria-labelledby="browser-onboarding-title"
      aria-describedby="browser-onboarding-description"
      onCancel={() => controller.current?.hide()}
    >
      <header class="dialog-header">
        <h2 id="browser-onboarding-title">安装 Chromium 浏览器</h2>
        <p id="browser-onboarding-description">
          推荐安装应用专用的 Chromium 浏览器，为账号提供独立的定制环境，
          <br />
          可加强同一平台下多个账号之间的隔离，并能解决部分设备无法调用系统浏览器的问题。
          <br />
          安装完成后，新添加的账号将自动使用定制环境。
        </p>
      </header>
      {state?.error && (
        <p class="runtime-settings-error" role="alert">
          {state.error}
        </p>
      )}
      <footer class="browser-onboarding-footer">
        <p class="browser-onboarding-hint">
          可前往设置 → 平台 → 浏览器环境完成安装。
        </p>
        <div class="browser-onboarding-actions">
          <button
            type="button"
            class="secondary-button"
            disabled={state?.dismissPending}
            onClick={() => void controller.current?.dismiss()}
          >
            不再提示
          </button>
          <button
            type="button"
            class="secondary-button"
            disabled={state?.dismissPending}
            onClick={() => controller.current?.hide()}
          >
            稍后
          </button>
          <button
            type="button"
            disabled={state?.dismissPending}
            onClick={() => {
              controller.current?.hide();
              globalThis.location.hash = browserSettingsHash;
            }}
          >
            前往安装
          </button>
        </div>
      </footer>
    </dialog>
  );
}
