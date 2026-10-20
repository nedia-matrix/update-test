import { useEffect, useRef, useState } from "preact/hooks";
import type { AccountBrowserProvider } from "@nedia-matrix/account-management";
import {
  AccountBrowserController,
  isSwitchActive,
  type AccountBrowserControllerState,
} from "../account-browser-controller.js";
import type { AccountBrowserSwitchStatus } from "../../../bridge/account-browser-switch.js";

const phases: Record<AccountBrowserSwitchStatus["phase"], string> = {
  unchanged: "账号已经使用所选环境",
  preparing: "正在准备新的浏览器环境…",
  awaiting_login: "请在新窗口登录当前账号，登录后会自动完成切换。",
  verifying: "正在确认登录的账号…",
  committing: "正在完成环境切换…",
  cancelling: "正在取消切换…",
  committed: "浏览器环境已切换",
  cancelled: "切换已取消，原环境已保留",
  failed: "切换未完成，原环境已保留",
};
export function AccountBrowserSettings({
  accountId,
  profileId,
  onBusy,
  disabled = false,
}: {
  accountId: string;
  profileId: string;
  onBusy(busy: boolean): void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<AccountBrowserControllerState>({
    pending: false,
  });
  const [target, setTarget] = useState<AccountBrowserProvider>();
  const controller = useRef<AccountBrowserController>();
  useEffect(() => {
    setState({ pending: false });
    setTarget(undefined);
    const instance = new AccountBrowserController(
      window.matrix,
      accountId,
      setState,
    );
    controller.current = instance;
    void instance.load();
    return () => {
      instance.dispose();
      controller.current = undefined;
    };
  }, [accountId, profileId]);
  const active = isSwitchActive(state.operation);
  useEffect(() => {
    onBusy(active || state.pending);
  }, [active, state.pending, accountId]);
  const environment = state.environment;
  const provider = environment?.provider;
  const error = state.error ?? state.operation?.error?.message;
  const needsSetup =
    state.error?.includes("定制浏览器") ||
    state.operation?.error?.code === "unavailable";
  const targetName = target === "fingerprint" ? "定制环境" : "标准环境";
  return (
    <section
      class="settings-surface account-browser-settings"
      aria-label="账号浏览器环境"
    >
      <header class="settings-section-header">
        <div>
          <h2>浏览器环境</h2>
          <p>仅对当前账号生效</p>
        </div>
      </header>
      <div class="account-settings-row">
        <div class="account-settings-copy">
          <strong
            title={
              environment?.version
                ? `浏览器版本：${environment.version}`
                : undefined
            }
          >
            {!environment
              ? error
                ? "暂时无法读取浏览器环境"
                : "正在读取…"
              : provider === "fingerprint"
                ? "定制环境"
                : provider === "system"
                  ? "标准环境"
                  : "暂时无法读取浏览器环境"}
          </strong>
          {provider && (
            <p>
              {environment?.externalKernel
                ? "使用指定浏览器"
                : provider === "fingerprint"
                  ? "使用专门的浏览器配置"
                  : "使用应用默认的浏览器配置"}
            </p>
          )}
        </div>
        <div class="account-settings-actions">
          {!active && !target && environment?.switchSupported && (
            <button
              class={
                provider === "system"
                  ? "primary-outline-button small-button"
                  : "secondary-button small-button"
              }
              type="button"
              disabled={state.pending || disabled}
              onClick={() =>
                setTarget(provider === "system" ? "fingerprint" : "system")
              }
            >
              {provider === "system" ? "切换到定制环境" : "切换到标准环境"}
            </button>
          )}
          {active && (
            <button
              class="secondary-button small-button"
              type="button"
              disabled={
                state.pending ||
                state.operation?.phase === "committing" ||
                state.operation?.phase === "cancelling"
              }
              onClick={() => void controller.current?.cancel()}
            >
              取消切换
            </button>
          )}
          {!environment && error && (
            <button
              class="secondary-button small-button"
              type="button"
              disabled={state.pending || disabled}
              onClick={() => void controller.current?.load()}
            >
              重试读取
            </button>
          )}
        </div>
      </div>
      {target && !active && (
        <div class="account-browser-switch-confirm">
          <strong>切换到{targetName}</strong>
          <p>
            请在新窗口重新登录同一个平台账号。账号资料和业务历史会保留；切换未完成时仍保留原环境。
          </p>
          <div class="account-settings-actions">
            <button
              class="secondary-button small-button"
              type="button"
              disabled={state.pending || disabled}
              onClick={() => setTarget(undefined)}
            >
              返回
            </button>
            <button
              class="small-button"
              type="button"
              disabled={state.pending || disabled}
              onClick={() => {
                void controller.current?.begin(target);
                setTarget(undefined);
              }}
            >
              开始重新登录
            </button>
          </div>
        </div>
      )}
      {!target && (environment?.blockingReason || state.operation || error) && (
        <div class="account-browser-feedback">
          {environment?.blockingReason && !active && (
            <p>{environment.blockingReason}</p>
          )}
          {state.operation && !error && (
            <p role="status">{phases[state.operation.phase]}</p>
          )}
          {error && <p role="alert">{error}</p>}
          {(needsSetup ||
            (state.operation?.error?.code === "cleanup" && !active)) && (
            <div class="account-settings-actions">
              {needsSetup && (
                <button
                  class="secondary-button small-button"
                  type="button"
                  onClick={() => {
                    globalThis.location.hash = "/settings";
                  }}
                >
                  前往应用设置
                </button>
              )}
              {state.operation?.error?.code === "cleanup" && !active && (
                <button
                  class="secondary-button small-button"
                  type="button"
                  disabled={state.pending || disabled}
                  onClick={() => void controller.current?.cancel()}
                >
                  重试完成清理
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
