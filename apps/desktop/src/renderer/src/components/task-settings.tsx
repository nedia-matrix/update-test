import { useEffect, useState } from "preact/hooks";
import type { TaskSettings as Settings } from "../../../bridge/tasks.js";
import { SettingsDisclosure } from "./settings-disclosure.js";
import { SettingsEditor } from "./settings-primitives.js";

export function TaskSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [parallel, setParallel] = useState(3);
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const load = () =>
    window.matrix.tasks
      .settings()
      .then((value) => {
        setSettings(value);
        setParallel(value.maxParallel);
        setDays(value.retentionDays);
        setError("");
      })
      .catch((error) => setError(String(error)));
  useEffect(() => {
    void load();
  }, []);
  const save = async () => {
    setPending(true);
    try {
      // Each saved value is reflected immediately, including partial failures.
      if (parallel !== settings?.maxParallel) {
        const value = await window.matrix.tasks.setMaxParallel(parallel);
        setSettings((current) => current && { ...current, maxParallel: value });
      }
      if (days !== settings?.retentionDays)
        setSettings(await window.matrix.tasks.setRetentionDays(days));
      setError("");
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsDisclosure
      class="task-scheduling"
      title="任务管理"
      summary={
        settings
          ? `最大并行 ${settings.maxParallel} · 记录保留 ${settings.retentionDays} 天`
          : "正在读取设置"
      }
      description="同步与发布共享名额（含待确认），同账号串行。已结束记录到期自动清理，待核实发布和业务数据保留。"
    >
      <SettingsEditor
        actions={
          <>
            <button
              class="secondary-button compact-button"
              type="button"
              disabled={
                !settings ||
                pending ||
                (parallel === settings.maxParallel &&
                  days === settings.retentionDays) ||
                !Number.isSafeInteger(parallel) ||
                parallel < 1 ||
                !Number.isSafeInteger(days) ||
                days < 1 ||
                days > Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000)
              }
              onClick={() => void save()}
            >
              {pending ? "正在保存…" : "保存"}
            </button>
            <a class="button-link secondary-button small-button" href="#/tasks">
              跳转任务管理
            </a>
          </>
        }
        feedback={
          error && (
            <p role="alert" class="settings-feedback settings-feedback-error">
              {error}
              {!settings && (
                <button
                  type="button"
                  class="text-button"
                  onClick={() => void load()}
                >
                  重新加载
                </button>
              )}
            </p>
          )
        }
      >
        <div class="settings-row-label">
          <input
            id="task-max-parallel"
            type="number"
            min="1"
            step="1"
            value={parallel}
            disabled={!settings || pending}
            onInput={(e) => setParallel(Number(e.currentTarget.value))}
          />
          <label for="task-max-parallel">最大并行任务数</label>
        </div>
        <div class="settings-row-label">
          <input
            type="number"
            min="1"
            step="1"
            id="task-retention-days"
            value={days}
            disabled={!settings || pending}
            onInput={(e) => setDays(Number(e.currentTarget.value))}
          />
          <label for="task-retention-days">已结束任务记录保留时长（天）</label>
        </div>
      </SettingsEditor>
    </SettingsDisclosure>
  );
}
