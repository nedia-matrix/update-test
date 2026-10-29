import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AppContext } from "../app-context.js";
import type {
  ScheduledTask,
  TaskQuery,
  TaskQueryResult,
  TaskState,
  TaskType,
  TaskClearState,
} from "../../../bridge/tasks.js";
import { taskGroups } from "../../../bridge/tasks.js";
import { publicationRecordsHref } from "../publishing-route.js";
import { Icon, type IconName } from "../components/icons.js";

const types: Record<TaskType, string> = {
  account_profile_sync: "资料同步",
  platform_content_sync: "作品同步",
  publication: "发布",
};
const typeIcons: Record<TaskType, IconName> = {
  account_profile_sync: "accounts",
  platform_content_sync: "content",
  publication: "publish",
};
const compactTaskInfo = (task: ScheduledTask) => {
  const info = task.waitReason || task.phase;
  const labels: Record<string, string> = {
    等待平台限流冷却: "限流冷却",
    等待账号空闲: "等待账号",
    等待并行名额: "等待名额",
    发布素材已持久化: "素材已保存",
    "发布执行已开始，禁止自动重放，请核实结果": "待核实发布结果",
    "同步中断，重试次数已用尽": "重试已用尽",
  };
  return labels[info] ?? info.replace(/^正在/, "").replace(/[…。]+$/, "");
};
const states: Record<TaskState, string> = {
  queued: "排队中",
  running: "执行中",
  awaiting_confirmation: "待确认",
  retry_wait: "等待重试",
  finalizing: "正在收尾",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  uncertain: "需核实",
};
const time = (value: number | null) =>
  value === null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
const duration = (task: ScheduledTask) =>
  task.startedAt === null
    ? "尚未开始"
    : `${Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.startedAt) / 1000))} 秒`;

type TaskScope = "in_progress" | "completed" | "failed" | "all";
const scopeGroup = (scope: TaskScope) => (scope === "all" ? undefined : scope);
const scopeOf = (query: TaskQuery): TaskScope =>
  query.group === "completed" || query.group === "failed"
    ? query.group
    : query.group
      ? "in_progress"
      : "all";
function routeQuery(): TaskQuery {
  const value = new URLSearchParams(location.hash.split("?")[1]).get("group");
  // Legacy links with mixed results open All; execution links use the new broad group.
  const scope: TaskScope =
    value === "completed" || value === "failed"
      ? value
      : value === "all" || value === "history" || value === "attention"
        ? "all"
        : "in_progress";
  return { limit: 30, offset: 0, group: scopeGroup(scope) };
}
export function TasksPage({ context }: { context: AppContext }) {
  const [query, setQuery] = useState<TaskQuery>(routeQuery);
  const [scope, setScope] = useState<TaskScope>(() => scopeOf(routeQuery()));
  const [data, setData] = useState<TaskQueryResult | null>(null);
  const [selected, setSelected] = useState<ScheduledTask | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [clearing, setClearing] = useState<TaskClearState | null>(null);
  const [dataScope, setDataScope] = useState("");
  const clearScopeKey = JSON.stringify([
    query.platformId,
    query.accountId,
    query.type,
  ]);
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    const changed = () => {
      const next = routeQuery();
      setQuery(next);
      setScope(scopeOf(next));
      setSelected(null);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  // This effect runs after the queried records have rendered. Acknowledgement only
  // affects notifications and is tied to the exact result version we displayed.
  useEffect(() => {
    const items = [...(data?.items ?? []), ...(selected ? [selected] : [])]
      .filter((task) => !!task.attentionVersion)
      .map((task) => ({ id: task.id, version: task.attentionVersion! }))
      .filter(
        (item) => !acknowledged.current.has(`${item.id}:${item.version}`),
      );
    const unique = [...new Map(items.map((item) => [item.id, item])).values()];
    if (!unique.length) return;
    unique.forEach((item) =>
      acknowledged.current.add(`${item.id}:${item.version}`),
    );
    void window.matrix.tasks.acknowledgeAttention(unique).catch(() => {
      unique.forEach((item) =>
        acknowledged.current.delete(`${item.id}:${item.version}`),
      );
    });
  }, [data, selected]);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await window.matrix.tasks.query(query);
      if (current !== revision.current) return;
      setData(result);
      setDataScope(
        JSON.stringify([query.platformId, query.accountId, query.type]),
      );
      setError("");
    } catch (error) {
      if (current === revision.current)
        setError(error instanceof Error ? error.message : "任务加载失败");
    }
  }, [query]);
  useEffect(() => {
    void refresh();
    const stop = window.matrix.onTasksChanged(() => void refresh());
    // Refresh elapsed time and recover notifications missed while the view was disconnected.
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      revision.current++;
      stop();
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const id =
      selected?.id ??
      new URLSearchParams(location.hash.split("?")[1]).get("taskId");
    if (id)
      void window.matrix.tasks
        .get(id)
        .then((task) => {
          if (active) setSelected(task);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [data, selected?.id]);
  const filter = (patch: Partial<TaskQuery>) =>
    setQuery({ ...query, ...patch, offset: 0 });
  const accountName = (id: string) => {
    const account = context.accounts.find((a) => a.id === id);
    return account?.nickname ?? account?.displayName ?? "已移除账号";
  };
  const cancel = async (task: ScheduledTask) => {
    setPending(true);
    try {
      setSelected(await window.matrix.tasks.cancel(task.id));
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "取消失败");
    } finally {
      setPending(false);
    }
  };
  const clearHistory = async (state: TaskClearState) => {
    setClearing(state);
    try {
      const result = await window.matrix.tasks.clearHistory({
        state,
        type: query.type,
        accountId: query.accountId,
        platformId: query.platformId,
      });
      if (selected) {
        const detail = await window.matrix.tasks.get(selected.id);
        setSelected((current) =>
          current?.id === selected.id ? detail : current,
        );
      }
      setQuery((current) => ({ ...current, offset: 0 }));
      context.setStatus(
        `已清除 ${result.removed} 条${state === "completed" ? "已完成" : "失败"}记录`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "清除记录失败");
    } finally {
      setClearing(null);
    }
  };
  const renderDetail = () =>
    selected && (
      <section class="task-detail" aria-label="任务详情">
        <div class="task-detail-title">
          <h2>
            {types[selected.type]} · {states[selected.state]}
          </h2>
        </div>
        {selected.state !== "finalizing" &&
          (selected.waitReason ?? selected.phase) !== states[selected.state] &&
          (selected.waitReason ?? selected.phase) !==
            selected.error?.message && (
            <p>{selected.waitReason ?? selected.phase}</p>
          )}
        <dl>
          <dt>账号</dt>
          <dd>{accountName(selected.accountId)}</dd>
          <dt>触发来源</dt>
          <dd>
            {selected.source === "automatic"
              ? "自动规则"
              : selected.source === "runtime"
                ? "本地服务"
                : "手动"}
            {selected.source === "automatic" && selected.hasManualRequest
              ? "，已关联手动请求"
              : ""}
          </dd>
          <dt>创建时间</dt>
          <dd>{time(selected.createdAt)}</dd>
          <dt>开始时间</dt>
          <dd>{time(selected.startedAt)}</dd>
          <dt>结束时间</dt>
          <dd>{time(selected.endedAt)}</dd>
          {selected.state === "retry_wait" && (
            <>
              <dt>下次重试</dt>
              <dd>{time(selected.nextAttemptAt)}</dd>
            </>
          )}
        </dl>
        {(selected.progress || !!selected.retainedItems) && (
          <p>
            {selected.progress &&
              `已读取 ${selected.progress.pages} 页、${selected.progress.items} 条作品。`}
            {!!selected.retainedItems &&
              `已保留至少 ${selected.retainedItems} 条作品快照，重试不会删除已取得的数据。`}
          </p>
        )}
        {selected.attempts && selected.attempts.length > 1 && (
          <div>
            <h3>执行记录</h3>
            {selected.attempts.map((attempt) => (
              <p key={attempt.attempt}>
                第 {attempt.attempt} 次 · {states[attempt.state]} ·{" "}
                {time(attempt.startedAt)}
                {attempt.runId ? ` · 同步记录 ${attempt.runId}` : ""}
                {attempt.error &&
                (attempt.attempt !== selected.attempt ||
                  attempt.error.message !== selected.error?.message)
                  ? ` · ${attempt.error.message}`
                  : ""}
              </p>
            ))}
          </div>
        )}
        {selected.error && <p class="task-error">{selected.error.message}</p>}
        {selected.type !== "publication" &&
          selected.error &&
          [
            "authentication",
            "identity_mismatch",
            "verification_required",
          ].includes(selected.error.code) && (
            <a href="#/accounts">前往账号页处理并恢复自动同步</a>
          )}
        {selected.publicationId && (
          <a href={publicationRecordsHref(undefined, selected.publicationId)}>
            查看发布详情与证据
          </a>
        )}
        {selected.state === "finalizing" && (
          <p>
            业务结果或资源退出尚未确认，账号仍被占用。请等待收尾；持续失败时重启应用进行恢复。
          </p>
        )}
      </section>
    );
  return (
    <div class="page-stack task-manager-page">
      <header class="workspace-header">
        <span class="workspace-header-icon">
          <Icon name="tasks" size={24} />
        </span>
        <div class="workspace-header-copy">
          <h1>任务管理</h1>
          <p>查看同步与发布的排队、执行进度和处理结果。</p>
        </div>
        <div
          class="task-clear-actions workspace-header-actions"
          aria-label="清除任务记录"
        >
          {(
            [
              ["completed", "清除已完成记录"],
              ["failed", "清除失败记录"],
            ] as const
          ).map(([state, label]) => (
            <button
              key={state}
              class="secondary-button compact-button"
              type="button"
              disabled={
                !!clearing ||
                pending ||
                dataScope !== clearScopeKey ||
                !data?.clearable[state]
              }
              title="按当前平台、账号和类型清除全部匹配的调度记录，不删除业务数据"
              onClick={() => void clearHistory(state)}
            >
              {clearing === state
                ? "清除中…"
                : `${label}（${data?.clearable[state] ?? 0}）`}
            </button>
          ))}
        </div>
      </header>
      {(error || data?.schedulerError) && (
        <p class="task-error" role="alert">
          {error || data?.schedulerError}
          {error && (
            <button
              class="text-button"
              type="button"
              onClick={() => void refresh()}
            >
              重新加载
            </button>
          )}
        </p>
      )}
      <section class="data-surface" aria-label="任务列表">
        <div class="task-list-toolbar">
          <div
            class="publication-group-tabs"
            role="group"
            aria-label="任务分组筛选"
          >
            {(
              [
                ["in_progress", "进行中", "除已完成和失败之外的所有任务"],
                ["completed", "已完成", "已完成的任务"],
                ["failed", "失败", "执行失败的任务"],
                ["all", "全部", "全部任务记录"],
              ] as const
            ).map(([value, label, description]) => (
              <button
                key={value}
                type="button"
                title={description}
                aria-pressed={scope === value}
                class={scope === value ? "active" : undefined}
                onClick={() => {
                  setScope(value);
                  filter({ group: scopeGroup(value), state: undefined });
                }}
              >
                <span>{label}</span>
                <span class="publication-tab-count">
                  {(value === "all"
                    ? (Object.keys(states) as TaskState[])
                    : taskGroups[value]
                  ).reduce((sum, state) => sum + (data?.counts[state] ?? 0), 0)}
                </span>
              </button>
            ))}
          </div>
          <div
            class="filter-controls task-header-filters"
            aria-label="任务筛选"
          >
            <label>
              平台
              <select
                aria-label="平台"
                value={query.platformId ?? ""}
                onChange={(e) =>
                  filter({ platformId: e.currentTarget.value || undefined })
                }
              >
                <option value="">全部平台</option>
                {context.platforms.map((p) => (
                  <option value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </label>
            <label>
              账号
              <select
                aria-label="账号"
                value={query.accountId ?? ""}
                onChange={(e) =>
                  filter({ accountId: e.currentTarget.value || undefined })
                }
              >
                <option value="">全部账号</option>
                {context.accounts.map((a) => (
                  <option value={a.id}>{a.nickname ?? a.displayName}</option>
                ))}
              </select>
            </label>
            <label>
              类型
              <select
                aria-label="任务类型"
                value={query.type ?? ""}
                onChange={(e) =>
                  filter({
                    type: (e.currentTarget.value as TaskType) || undefined,
                  })
                }
              >
                <option value="">全部类型</option>
                {Object.entries(types).map(([value, label]) => (
                  <option value={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div class="task-list-heading" aria-hidden="true">
          <span>任务</span>
          <span>平台 / 账号</span>
          <span>状态信息</span>
          <span>时间</span>
          <span class="task-actions-heading">操作</span>
        </div>
        <div class="task-list" aria-live="polite">
          {!data && !error && <div class="task-empty">正在加载任务…</div>}
          {data?.items.length === 0 && (
            <div class="task-empty">
              <strong>暂无符合条件的任务</strong>
              <p>手动同步或发布后，可在这里跟踪进度和查看结果。</p>
            </div>
          )}
          {data?.items.map((task) => (
            <article
              key={task.id}
              class={`task-row${selected?.id === task.id ? " expanded" : ""}`}
            >
              <div class="content-summary-cell">
                <span
                  class="content-type-icon"
                  role="img"
                  aria-label={types[task.type]}
                  title={types[task.type]}
                >
                  <Icon name={typeIcons[task.type]} size={18} />
                </span>
                <span>
                  <strong>{types[task.type]}</strong>
                  <small>
                    {task.source === "automatic"
                      ? "自动规则"
                      : task.source === "runtime"
                        ? "本地服务"
                        : "手动触发"}
                  </small>
                </span>
              </div>
              <div class="content-account-cell">
                <strong>
                  {context.platforms.find(
                    (platform) => platform.id === task.platformId,
                  )?.displayName ?? task.platformId}
                </strong>
                <small>{accountName(task.accountId)}</small>
              </div>
              <div class="task-row-status">
                <span
                  class={`status-badge task-info-tag task-status-${task.state}`}
                  title={task.waitReason || task.phase}
                >
                  {states[task.state]}
                </span>
                {compactTaskInfo(task) !== states[task.state] && (
                  <small
                    class="task-row-description"
                    title={task.waitReason || task.phase}
                  >
                    {compactTaskInfo(task)}
                  </small>
                )}
                {task.progress && (
                  <span class="status-badge task-info-tag">
                    {task.progress.pages} 页 · {task.progress.items} 条
                  </span>
                )}
              </div>
              <div class="content-time-cell">
                <strong>{time(task.startedAt ?? task.createdAt)}</strong>
                <small>
                  {task.startedAt === null
                    ? "尚未开始"
                    : `历时 ${duration(task)}`}
                </small>
              </div>
              <div class="row-actions task-row-actions">
                {["queued", "retry_wait"].includes(task.state) && (
                  <button
                    class="text-button"
                    type="button"
                    disabled={pending}
                    onClick={() => void cancel(task)}
                  >
                    取消排队
                  </button>
                )}
                {task.state === "awaiting_confirmation" &&
                  task.publicationId && (
                    <button
                      class="text-button"
                      type="button"
                      onClick={() =>
                        void window.matrix
                          .openPublicationReview({
                            publicationId: task.publicationId!,
                          })
                          .catch((error) => setError(String(error)))
                      }
                    >
                      返回发布页面
                    </button>
                  )}
                <button
                  class="icon-button"
                  type="button"
                  aria-expanded={selected?.id === task.id}
                  aria-label={
                    selected?.id === task.id ? "收起任务详情" : "展开任务详情"
                  }
                  onClick={() => {
                    if (selected?.id === task.id) {
                      setSelected(null);
                      history.replaceState(null, "", "#/tasks");
                    } else setSelected(task);
                  }}
                >
                  <Icon name="chevron-down" />
                </button>
              </div>
              {selected?.id === task.id && renderDetail()}
            </article>
          ))}
        </div>
        <footer class="task-pagination">
          <span>共 {data?.total ?? 0} 项</span>
          {((data?.total ?? 0) > (query.limit ?? 30) ||
            (query.offset ?? 0) > 0) && (
            <>
              <button
                class="secondary-button compact-button"
                type="button"
                disabled={!(query.offset ?? 0)}
                onClick={() =>
                  setQuery({
                    ...query,
                    offset: Math.max(0, (query.offset ?? 0) - 30),
                  })
                }
              >
                上一页
              </button>
              <button
                class="secondary-button compact-button"
                type="button"
                disabled={
                  !data || (query.offset ?? 0) + data.items.length >= data.total
                }
                onClick={() =>
                  setQuery({ ...query, offset: (query.offset ?? 0) + 30 })
                }
              >
                下一页
              </button>
            </>
          )}
        </footer>
      </section>
      {selected &&
        !data?.items.some((task) => task.id === selected.id) &&
        renderDetail()}
    </div>
  );
}
