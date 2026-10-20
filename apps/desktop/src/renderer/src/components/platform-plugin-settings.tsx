import { useEffect, useState } from "preact/hooks";
import type { PlatformPluginSummary } from "../../../bridge/plugins.js";
import { updateErrorMessage } from "../application-update-errors.js";

export function PlatformPluginSettings() {
  const [plugins, setPlugins] = useState<PlatformPluginSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
          onClick={() => void run(() => window.matrix.installPlugin())}
        >
          安装插件
        </button>
      </header>
      {plugins.map((plugin) => (
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
      {error && (
        <p class="runtime-settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
