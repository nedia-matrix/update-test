import { useEffect, useRef, useState } from "preact/hooks";
import type { TaskSummary } from "../../../bridge/tasks.js";
import type { PlatformAccountView } from "@nedia-matrix/account-management";
import { Icon } from "./icons.js";

const types = {
  account_profile_sync: "资料同步",
  platform_content_sync: "作品同步",
  publication: "发布",
};
export function TaskDrawer({
  accounts,
}: {
  accounts: readonly PlatformAccountView[];
}) {
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const current = ++revision.current;
      try {
        const result = await window.matrix.tasks.summary();
        if (active && current === revision.current) {
          setSummary(result);
          setError("");
        }
      } catch {
        if (active && current === revision.current)
          setError("任务状态暂不可用");
      }
    };
    const refreshNow = () => void refresh();
    refreshNow();
    const stop = window.matrix.onTasksChanged(refreshNow);
    const timer = setInterval(refreshNow, 5000);
    window.addEventListener("online", refreshNow);
    window.addEventListener("focus", refreshNow);
    return () => {
      active = false;
      stop();
      clearInterval(timer);
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("focus", refreshNow);
    };
  }, []);
  const issue = error || summary?.schedulerError;
  if (
    !issue &&
    (!summary ||
      (!summary.occupied && !summary.queued && !summary.unseenAttention))
  )
    return null;
  const group = summary?.occupied || summary?.queued ? "in_progress" : "all";
  return (
    <section class="task-drawer" aria-label="任务状态">
      <div class="task-drawer-header">
        <a href={`#/tasks?group=${group}`}>
          <strong>任务</strong>
          <small>
            {summary ? (
              <>
                执行中 {summary.occupied}/{summary.maxParallel}
                {summary.queued > 0 && ` · 排队 ${summary.queued}`}
              </>
            ) : (
              "查看任务管理"
            )}
          </small>
        </a>
        <button
          type="button"
          class="icon-button"
          aria-label={expanded ? "收起任务抽屉" : "展开任务抽屉"}
          aria-expanded={expanded}
          aria-controls="task-drawer-content"
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
      {issue && (
        <a class="task-drawer-issue" href="#/tasks">
          {issue}
        </a>
      )}
      {!!summary?.unseenAttention && (
        <a class="task-drawer-issue" href="#/tasks?group=all">
          {summary.unseenAttention} 项新异常待查看
        </a>
      )}
      {summary && (
        <div
          id="task-drawer-content"
          class="task-drawer-content"
          hidden={!expanded}
        >
          {summary.items.map((task) => (
            <a
              key={task.id}
              class="task-drawer-item"
              href={`#/tasks?taskId=${encodeURIComponent(task.id)}`}
            >
              <strong>
                {types[task.type]} ·{" "}
                {accounts.find((a) => a.id === task.accountId)?.nickname ??
                  accounts.find((a) => a.id === task.accountId)?.displayName ??
                  "已移除账号"}
              </strong>
              <small>{task.phase}</small>
            </a>
          ))}
          {summary.remaining > 0 && (
            <a href="#/tasks?group=in_progress">另有 {summary.remaining} 项</a>
          )}
          {summary.queued > 0 && (
            <a href="#/tasks?group=in_progress" class="task-drawer-wait">
              {summary.waitReasons.join(" · ")}
            </a>
          )}
        </div>
      )}
    </section>
  );
}
