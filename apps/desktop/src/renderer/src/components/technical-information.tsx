import { SettingsEditor } from "./settings-primitives.js";
import { SettingsDisclosure } from "./settings-disclosure.js";
import { useState } from "preact/hooks";
import type { ApplicationTechnicalInformation } from "../../../bridge/contracts.js";
import type { AppContext } from "../app-context.js";
import { Icon } from "./icons.js";

export function TechnicalInformation({ context }: { context: AppContext }) {
  const [information, setInformation] =
    useState<ApplicationTechnicalInformation>();
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
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
          `chromium ${information.browserVersion}${information.browserAvailable ? "" : "（未安装或暂不可用）"}`,
        ],
        [
          "操作系统与架构",
          `${information.operatingSystem} · ${information.architecture}`,
        ],
      ]
    : [];
  return (
    <SettingsDisclosure
      class="technical-information"
      title="技术信息"
      onOpenChange={(open) => {
        if (open && !loading) void load();
      }}
    >
      <SettingsEditor
        actions={
          <>
            <button
              class="secondary-button small-button"
              type="button"
              disabled={copying || loading || !information}
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
            <button
              class="secondary-button small-button"
              type="button"
              disabled={opening}
              onClick={async () => {
                setOpening(true);
                try {
                  await window.matrix.openDiagnosticDirectory();
                  context.setStatus("已打开本地诊断目录");
                } catch (error) {
                  context.setStatus(
                    `无法打开日志目录：${error instanceof Error ? error.message : String(error)}`,
                    "error",
                  );
                } finally {
                  setOpening(false);
                }
              }}
            >
              {opening ? "正在打开…" : "打开日志目录"}
            </button>
            <p class="settings-feedback">
              日志与截图最多 100 MiB · 保留 14 天
            </p>
          </>
        }
      >
        {loading ? (
          <p class="settings-feedback" role="status">
            正在读取技术信息…
          </p>
        ) : error ? (
          <SettingsEditor
            actions={
              <button
                class="secondary-button small-button"
                type="button"
                onClick={() => void load()}
              >
                重试读取
              </button>
            }
          >
            <p class="settings-feedback settings-feedback-error" role="alert">
              {error}
            </p>
          </SettingsEditor>
        ) : information ? (
          <dl class="settings-list">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </SettingsEditor>
    </SettingsDisclosure>
  );
}
