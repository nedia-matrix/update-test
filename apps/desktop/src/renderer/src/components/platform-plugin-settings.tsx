import { useEffect, useRef, useState } from "preact/hooks";
import type {
  BundledPlatformPlugin,
  PlatformPluginSummary,
} from "../../../bridge/plugins.js";
import { updateErrorMessage } from "../application-update-errors.js";
import { visiblePlugins, bundledPluginAction } from "../plugin-installation.js";

export function PlatformPluginSettings() {
  const [plugins, setPlugins] = useState<PlatformPluginSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installerOpen, setInstallerOpen] = useState(false);
  const [source, setSource] = useState<"bundled" | "custom">("bundled");
  const [bundled, setBundled] = useState<BundledPlatformPlugin[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (installerOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [installerOpen]);
  const openInstaller = async () => {
    setInstallerOpen(true);
    setSource("bundled");
    setBundled([]);
    setBusy(true);
    setError(null);
    try {
      setBundled(await window.matrix.listBundledPlugins());
    } catch (cause) {
      setError(updateErrorMessage(cause, "无法读取默认插件"));
    } finally {
      setBusy(false);
    }
  };
  const run = async (operation: () => Promise<PlatformPluginSummary[]>) => {
    setBusy(true);
    setError(null);
    try {
      setPlugins(await operation());
    } catch (cause) {
      setError(updateErrorMessage(cause, "插件操作失败"));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(() => window.matrix.listPlugins());
  }, []);
  return (
    <section
      class="settings-surface platform-plugin-settings"
      aria-labelledby="platform-plugin-title"
    >
      <header class="settings-section-header">
        <div>
          <h2 id="platform-plugin-title">平台插件</h2>
          <p>
            安装、替换、启停和卸载在重启应用后生效。卸载保留账号与发布历史。
          </p>
        </div>
        <button
          class="small-button"
          type="button"
          disabled={busy}
          onClick={() => void openInstaller()}
        >
          安装插件
        </button>
      </header>
      {visiblePlugins(plugins).length === 0 && (
        <p class="plugin-install-hint">暂无已安装插件，点击“安装插件”添加。</p>
      )}
      {visiblePlugins(plugins).map((plugin) => (
        <div class="runtime-settings-row" key={plugin.id}>
          <div class="runtime-settings-status">
            <span>
              <strong>{plugin.displayName}</strong>
              <small>
                {plugin.installed
                  ? `${plugin.version ?? "未知版本"} · ${plugin.available ? "可用" : plugin.enabled ? "不可用" : "已停用"}`
                  : "未安装"}
              </small>
              {plugin.pending && (
                <small>
                  待重启生效：
                  {
                    {
                      install: "安装或替换",
                      enable: "启用",
                      disable: "停用",
                      remove: "卸载",
                    }[plugin.pending]
                  }
                </small>
              )}
              {plugin.error && <small role="alert">{plugin.error}</small>}
            </span>
          </div>
          <div class="update-settings-actions">
            {plugin.installed && (
              <>
                <button
                  class="secondary-button compact-button"
                  type="button"
                  disabled={busy || !!plugin.pending}
                  onClick={() =>
                    void run(() =>
                      window.matrix.changePlugin({
                        id: plugin.id,
                        action: plugin.enabled ? "disable" : "enable",
                      }),
                    )
                  }
                >
                  {plugin.enabled ? "停用" : "启用"}
                </button>
                <button
                  class="secondary-button compact-button"
                  type="button"
                  disabled={busy || !!plugin.pending}
                  onClick={() =>
                    void run(() =>
                      window.matrix.changePlugin({
                        id: plugin.id,
                        action: "remove",
                      }),
                    )
                  }
                >
                  卸载
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      <dialog
        ref={dialog}
        class="plugin-install-dialog"
        aria-label="安装插件"
        aria-describedby="plugin-install-description"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setInstallerOpen(false);
        }}
        onClose={() => setInstallerOpen(false)}
      >
        <nav
          class="workspace-tabs settings-tabs"
          role="tablist"
          aria-label="插件来源"
        >
          {(
            [
              { id: "bundled", label: "默认插件" },
              { id: "custom", label: "自定义插件" },
            ] as const
          ).map(({ id, label }) => (
            <button
              key={id}
              id={`plugin-install-tab-${id}`}
              type="button"
              role="tab"
              class={source === id ? "active" : undefined}
              aria-selected={source === id}
              aria-controls={`plugin-install-panel-${id}`}
              tabIndex={source === id ? 0 : -1}
              disabled={busy}
              onClick={() => setSource(id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "Home"
                    ? "bundled"
                    : event.key === "End"
                      ? "custom"
                      : ["ArrowLeft", "ArrowRight"].includes(event.key)
                        ? source === "bundled"
                          ? "custom"
                          : "bundled"
                        : undefined;
                if (!next) return;
                event.preventDefault();
                setSource(next);
                document.getElementById(`plugin-install-tab-${next}`)?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div
          id="plugin-install-panel-bundled"
          role="tabpanel"
          aria-labelledby="plugin-install-tab-bundled"
          tabIndex={0}
          aria-busy={busy}
          hidden={source !== "bundled"}
        >
          {bundled.map((bundle) => {
            const installed = plugins.find((plugin) => plugin.id === bundle.id);
            const operation = bundledPluginAction(bundle, installed);
            return (
              <div class="runtime-settings-row" key={bundle.id}>
                <div class="plugin-install-summary">
                  {bundle.iconUrl && (
                    <img src={bundle.iconUrl} alt="" width="32" height="32" />
                  )}
                  <span>
                    <strong>{bundle.displayName}</strong>
                    <small>
                      默认版本：{bundle.version}
                      {installed?.installed
                        ? ` · 已安装：${installed.version ?? "未知版本"}`
                        : ""}
                    </small>
                    {operation.label === "替换为默认版本" && (
                      <small>将替换当前插件，可能回退到较早版本。</small>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  class="secondary-button compact-button"
                  disabled={busy || !operation.action}
                  onClick={() =>
                    void run(() =>
                      operation.action === "enable"
                        ? window.matrix.changePlugin({
                            id: bundle.id,
                            action: "enable",
                          })
                        : window.matrix.installBundledPlugin(bundle.id),
                    )
                  }
                >
                  {operation.label}
                </button>
              </div>
            );
          })}
          {!busy && !error && bundled.length === 0 && (
            <p>当前应用没有默认插件，可选择自定义插件安装。</p>
          )}
        </div>
        <div
          class="plugin-install-custom"
          id="plugin-install-panel-custom"
          role="tabpanel"
          aria-labelledby="plugin-install-tab-custom"
          tabIndex={0}
          hidden={source !== "custom"}
        >
          <button
            type="button"
            class="primary-button"
            disabled={busy}
            onClick={() => void run(() => window.matrix.installPlugin())}
          >
            选择插件文件
          </button>
          {plugins.some((plugin) => plugin.pending === "install") && (
            <p>插件安装已提交，请重启应用生效。</p>
          )}
        </div>
        {error && (
          <p class="runtime-settings-error" role="alert">
            {error}
          </p>
        )}
        <footer class="plugin-install-footer">
          <p id="plugin-install-description" class="plugin-install-hint">
            {source === "bundled"
              ? "安装或恢复默认插件，保留账号、设置与发布历史。重启应用后生效。"
              : "从本地安装 .nmp 插件包，安装前校验签名和兼容性。重启应用后生效。"}
          </p>
          <button
            type="button"
            class="secondary-button"
            disabled={busy}
            onClick={() => setInstallerOpen(false)}
          >
            关闭
          </button>
        </footer>
      </dialog>
      {error && !installerOpen && (
        <p class="runtime-settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
