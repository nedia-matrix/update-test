import { SettingsRow, SegmentedControl } from "./settings-primitives.js";
import { useEffect, useState } from "preact/hooks";
import type { SyncRule } from "../../../bridge/tasks.js";

const titles = {
  account_profile_sync: "资料自动同步",
  platform_content_sync: "作品自动同步",
};

export function SyncRules({ accountId }: { accountId: string }) {
  const [rules, setRules] = useState<SyncRule[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void window.matrix.tasks
        .rules(accountId)
        .then((r) => {
          if (active) setRules(r);
        })
        .catch((error) => {
          if (active) setError(String(error));
        });
    refresh();
    const stop = window.matrix.onTasksChanged(refresh);
    return () => {
      active = false;
      stop();
    };
  }, [accountId]);
  const save = async (rule: SyncRule, resume = false) => {
    setPending(true);
    setError("");
    try {
      await window.matrix.tasks.setRule({ ...rule, resume });
      setRules(await window.matrix.tasks.rules(accountId));
    } catch (error) {
      setError(error instanceof Error ? error.message : "规则保存失败");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {(["account_profile_sync", "platform_content_sync"] as const).map(
        (type) => {
          const rule = rules.find((rule) => rule.type === type);
          return rule ? (
            <SyncRuleRow
              key={`${accountId}:${type}`}
              rule={rule}
              pending={pending}
              save={save}
            />
          ) : (
            <SettingsRow
              key={`${accountId}:${type}`}
              title={titles[type]}
              description={error ? "读取失败" : "正在读取…"}
            >
              <span class="settings-row-value">—</span>
            </SettingsRow>
          );
        },
      )}
      {error && (
        <p role="alert" class="settings-feedback settings-feedback-error">
          {error}
        </p>
      )}
    </>
  );
}
function SyncRuleRow({
  rule,
  pending,
  save,
}: {
  rule: SyncRule;
  pending: boolean;
  save(rule: SyncRule, resume?: boolean): Promise<void>;
}) {
  const [hours, setHours] = useState(rule.intervalMs / 3_600_000);
  useEffect(() => setHours(rule.intervalMs / 3_600_000), [rule.intervalMs]);
  const description = !rule.enabled
    ? "未启用，仅在应用运行期间执行。"
    : rule.pausedReason
      ? `已暂停：${rule.pausedReason}`
      : `下次同步：${new Date(rule.nextDueAt).toLocaleString("zh-CN", { hour12: false })}。手动同步后顺延。`;
  return (
    <SettingsRow title={titles[rule.type]} description={description}>
      <div class="settings-actions sync-rule-controls">
        <input
          aria-label={`${rule.type === "account_profile_sync" ? "资料" : "作品"}同步周期（小时）`}
          type="number"
          min="1"
          step="1"
          value={hours}
          disabled={pending || !rule.enabled}
          onInput={(e) => setHours(Number(e.currentTarget.value))}
        />
        <span class="sync-rule-unit">小时 / 次</span>
        <button
          class="secondary-button compact-button"
          type="button"
          disabled={
            pending ||
            !rule.enabled ||
            !Number.isFinite(hours) ||
            hours < 1 ||
            hours * 3_600_000 === rule.intervalMs
          }
          onClick={() => void save({ ...rule, intervalMs: hours * 3_600_000 })}
        >
          保存
        </button>
        {rule.enabled && rule.pausedReason && (
          <button
            class="secondary-button compact-button"
            type="button"
            disabled={pending}
            onClick={() => void save({ ...rule, enabled: true }, true)}
          >
            恢复自动同步
          </button>
        )}
        <SegmentedControl
          label={`${titles[rule.type]}开关`}
          value={rule.enabled}
          options={[
            { value: true, label: "启用" },
            { value: false, label: "关闭" },
          ]}
          disabled={pending}
          onChange={(enabled) => void save({ ...rule, enabled })}
        />
      </div>
    </SettingsRow>
  );
}
