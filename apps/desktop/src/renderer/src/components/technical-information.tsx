import { useState } from "preact/hooks";
import type { ApplicationTechnicalInformation } from "../../../bridge/contracts.js";
import type { AppContext } from "../app-context.js";
import { Icon } from "./icons.js";

export function TechnicalInformation({ context }: { context: AppContext }) {
  const [information, setInformation] =
    useState<ApplicationTechnicalInformation>();
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setInformation(await window.matrix.getTechnicalInformation());
    } catch {
      setError("技术信息读取失败，请重试。");
    } finally {
      setLoading(false);
    }
  };
  const rows = information
    ? [
        ["应用版本", information.applicationVersion],
        ["数据库结构版本", String(information.databaseSchemaVersion)],
        ["SQLite 引擎版本", information.sqliteVersion],
        [
          "定制浏览器版本",
          `${information.browserVersion}${information.browserAvailable ? "" : "（未安装或暂不可用）"}`,
        ],
        [
          "操作系统与架构",
          `${information.operatingSystem} · ${information.architecture}`,
        ],
      ]
    : [];
  return (
    <details
      class="technical-information"
      onToggle={(event) => {
        if (event.currentTarget.open && !loading) void load();
      }}
    >
      <summary>
        <Icon name="chevron-down" size={14} />
        <strong>技术信息</strong>
        <span>用于排查问题和反馈</span>
      </summary>
      <div class="technical-information-body">
        {loading ? (
          <p class="update-check-feedback" role="status">
            正在读取技术信息…
          </p>
        ) : error ? (
          <div class="technical-information-error">
            <p class="update-check-feedback update-check-error" role="alert">
              {error}
            </p>
            <button
              class="secondary-button small-button"
              type="button"
              onClick={() => void load()}
            >
              重试读取
            </button>
          </div>
        ) : information ? (
          <>
            <dl class="settings-list">
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <div class="technical-information-actions">
              <button
                class="secondary-button small-button"
                type="button"
                disabled={copying}
                onClick={async () => {
                  setCopying(true);
                  try {
                    await navigator.clipboard.writeText(
                      rows
                        .map(([label, value]) => `${label}：${value}`)
                        .join("\n"),
                    );
                    context.setStatus("技术信息已复制");
                  } catch {
                    context.setStatus("无法复制技术信息，请重试", "error");
                  } finally {
                    setCopying(false);
                  }
                }}
              >
                <Icon name="copy" size={14} />
                {copying ? "正在复制…" : "复制技术信息"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}
