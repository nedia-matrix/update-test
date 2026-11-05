import {
  SettingsSection,
  SettingsHeader,
  SettingsEditor,
} from "./settings-primitives.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { SettingsDisclosure } from "./settings-disclosure.js";
import {
  BrowserSettingsController,
  isFingerprintTaskActive,
  type BrowserSettingsState,
} from "../browser-settings-controller.js";

const phaseLabels = {
  checking: "正在校验",
  missing: "未安装",
  ready: "已安装",
  downloading: "正在下载",
  extracting: "正在解压",
  verifying: "正在检查浏览器",
  publishing: "正在完成安装",
  cancelling: "正在取消安装",
  cancelled: "安装已取消",
  failed: "安装失败",
};
const bytes = (value: number) => (value / 1048576).toFixed(1);
export function BrowserSettings() {
  const [state, setState] = useState<BrowserSettingsState>({
    status: null,
    defaultProvider: null,
    actionPending: false,
    error: null,
  });
  const controller = useRef<BrowserSettingsController | null>(null);
  useEffect(() => {
    const instance = new BrowserSettingsController(window.matrix, setState);
    controller.current = instance;
    void instance.start();
    return () => {
      instance.dispose();
      controller.current = null;
    };
  }, []);
  const status = state.status;
  const active = isFingerprintTaskActive(status);
  return (
    <SettingsSection
      id="browser-settings"
      tabIndex={-1}
      aria-labelledby="browser-settings-title"
    >
      <SettingsHeader
        title="浏览器环境"
        titleId="browser-settings-title"
        summary={
          <>
            {state.actionPending
              ? "正在准备并保存…"
              : state.defaultProvider === null
                ? "正在读取偏好"
                : `新账号默认：${state.defaultProvider === "fingerprint" ? "定制环境" : "标准环境"}`}
            {active && status && <span>{phaseLabels[status.phase]}</span>}
          </>
        }
        actions={
          <button
            class={
              state.defaultProvider === "fingerprint"
                ? "secondary-button"
                : "primary-outline-button"
            }
            type="button"
            role="switch"
            aria-checked={state.defaultProvider === "fingerprint"}
            disabled={
              !status ||
              (!status.supported && state.defaultProvider !== "fingerprint") ||
              state.defaultProvider === null ||
              state.actionPending ||
              active
            }
            onClick={() =>
              void controller.current?.setDefault(
                state.defaultProvider === "fingerprint"
                  ? "system"
                  : "fingerprint",
              )
            }
          >
            {state.defaultProvider === "fingerprint"
              ? "改用标准环境"
              : "改用定制环境"}
          </button>
        }
      />
      <SettingsDisclosure
        title="定制浏览器"
        description="安装后用于新账号，已有账号可单独调整"
        summary={status?.available ? "已安装" : "未安装"}
      >
        <SettingsEditor
          actions={
            <>
              {active ? (
                <button
                  class="secondary-button compact-button"
                  type="button"
                  disabled={
                    status?.phase === "cancelling" ||
                    status?.phase === "publishing"
                  }
                  onClick={() => void controller.current?.cancel()}
                >
                  取消安装
                </button>
              ) : (
                <button
                  class="secondary-button compact-button"
                  type="button"
                  disabled={!status || !status.supported || state.actionPending}
                  onClick={() => void controller.current?.install()}
                >
                  {status?.available ? "修复浏览器" : "安装并用于新账号"}
                </button>
              )}
            </>
          }
        >
          <div class="update-settings-summary">
            <div class="update-settings-feedback">
              <p class="settings-feedback" aria-live="polite">
                {status ? phaseLabels[status.phase] : "正在读取状态"}
                {status?.available && status.phase !== "ready"
                  ? " · 已安装的浏览器仍可用"
                  : ""}
              </p>
              {status?.phase === "downloading" && (
                <div class="update-download-progress" role="status">
                  <progress
                    max={status.totalBytes || 1}
                    value={status.totalBytes ? status.receivedBytes : undefined}
                    aria-label="定制浏览器下载进度"
                  />
                  <span>
                    {status.totalBytes
                      ? `${Math.min(100, Math.floor((status.receivedBytes / status.totalBytes) * 100))}% · ${bytes(status.receivedBytes)} / ${bytes(status.totalBytes)} MiB`
                      : `已下载 ${bytes(status.receivedBytes)} MiB`}
                  </span>
                </div>
              )}
            </div>
          </div>
        </SettingsEditor>
      </SettingsDisclosure>
      {(state.error || status?.error) && (
        <p class="runtime-settings-error" role="alert">
          {state.error ?? status?.error?.message}
        </p>
      )}
    </SettingsSection>
  );
}
