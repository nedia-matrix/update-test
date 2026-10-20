import type {
  PlatformContentSnapshot,
  PlatformContentSyncRun,
} from "@nedia-matrix/platform-content";
import { useEffect, useMemo, useState } from "preact/hooks";

import type { AppContext } from "../app-context.js";
import { Icon } from "../components/icons.js";
import {
  accountLabel,
  errorMessage,
  formatTime,
  isPlatformAvailable,
} from "../shared.js";

interface ContentState {
  items: PlatformContentSnapshot[];
  latestRun: PlatformContentSyncRun | null;
}

const emptyState: ContentState = { items: [], latestRun: null };

export function PlatformContentsPage({
  context,
  fixedAccountId,
  refreshToken = 0,
}: {
  context: AppContext;
  fixedAccountId?: string;
  refreshToken?: number;
}) {
  const [accounts, setAccounts] = useState(context.accounts);
  const [accountId, setAccountId] = useState(fixedAccountId ?? "");
  const [data, setData] = useState<ContentState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let active = true;
    void context
      .refreshAccounts()
      .then((refreshed) => {
        if (!active) return;
        setAccounts(refreshed);
        if (fixedAccountId) {
          setAccountId(fixedAccountId);
          return;
        }
        setAccountId((selected) =>
          refreshed.some(({ id }) => id === selected)
            ? selected
            : (refreshed.find(({ status }) => status === "authenticated")?.id ??
              refreshed[0]?.id ??
              ""),
        );
      })
      .catch((error) =>
        context.setStatus(errorMessage(error, "账号加载失败"), "error"),
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    const stopUpdates = context.onAccountUpdate((refreshed) => {
      if (active) setAccounts(refreshed);
    });
    return () => {
      active = false;
      stopUpdates();
    };
  }, [context, fixedAccountId]);

  useEffect(() => {
    if (fixedAccountId) setAccountId(fixedAccountId);
  }, [fixedAccountId]);

  useEffect(() => {
    if (!accountId) {
      setData(emptyState);
      return;
    }
    let active = true;
    setLoading(true);
    void window.matrix
      .listPlatformContents({ accountId })
      .then((result) => {
        if (active) setData(result);
      })
      .catch((error) => {
        if (active)
          context.setStatus(errorMessage(error, "平台作品加载失败"), "error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, context, refreshToken]);

  const account = useMemo(
    () => accounts.find(({ id }) => id === accountId),
    [accountId, accounts],
  );

  const synchronize = async () => {
    if (!accountId) return;
    setSyncing(true);
    context.setStatus("正在从平台读取作品和最新指标…", "busy");
    try {
      const run = await window.matrix.refreshPlatformContents({ accountId });
      const refreshed = await window.matrix.listPlatformContents({ accountId });
      setData(refreshed);
      if (run.status === "failed") {
        context.setStatus(run.diagnostics[0] ?? "平台作品同步失败", "error");
      } else if (run.status === "partial") {
        context.setStatus(
          run.diagnostics[0] ?? `已读取 ${run.itemsRead} 条作品，结果不完整`,
          "error",
        );
      } else {
        context.setStatus(`已同步 ${run.itemsRead} 条平台作品`);
      }
    } catch (error) {
      context.setStatus(errorMessage(error, "平台作品同步失败"), "error");
    } finally {
      setSyncing(false);
    }
  };

  const openContent = async (content: PlatformContentSnapshot) => {
    if (
      !content.contentUrl ||
      !isPlatformAvailable(context.platforms, content.platformId)
    )
      return;
    try {
      await window.matrix.openPlatformContent({
        accountId: content.accountId,
        externalContentId: content.externalContentId,
      });
    } catch (error) {
      context.setStatus(errorMessage(error, "打开平台内容失败"), "error");
    }
  };

  return (
    <div class="page-stack">
      {!fixedAccountId && (
        <section class="page-toolbar content-toolbar" aria-label="平台作品操作">
          <div class="filter-controls">
            <label>
              账号
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.currentTarget.value)}
              >
                {accounts.length === 0 && <option value="">暂无账号</option>}
                {accounts.map((item) => (
                  <option value={item.id} key={item.id}>
                    {accountLabel(item, context.platforms)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            class="compact-button"
            disabled={
              !account ||
              account.status !== "authenticated" ||
              syncing ||
              !isPlatformAvailable(context.platforms, account.platformId)
            }
            onClick={() => void synchronize()}
          >
            <Icon name="refresh" size={16} />
            {syncing ? "同步中" : "同步作品"}
          </button>
        </section>
      )}

      <section class="data-surface" aria-labelledby="platform-content-title">
        <header class="surface-header">
          <div>
            <h2 id="platform-content-title">平台作品快照</h2>
            <p>
              显示最近一次手动同步保存的作品和指标，共 {data.items.length} 条。
            </p>
          </div>
          {data.latestRun && <SyncRunStatus run={data.latestRun} />}
        </header>
        <div class="platform-content-heading" aria-hidden="true">
          <span>作品</span>
          <span>内容类型</span>
          <span>指标</span>
          <span>平台状态</span>
          <span>数据时间</span>
        </div>
        <div class="content-list" aria-live="polite">
          {loading ? (
            <EmptyContent title="正在加载平台作品…" />
          ) : data.items.length === 0 ? (
            <EmptyContent
              title="还没有平台作品快照"
              detail="点击账号顶部的“同步作品”读取平台内容。"
            />
          ) : (
            data.items.map((content) => (
              <PlatformContentRow
                content={content}
                platformAvailable={isPlatformAvailable(
                  context.platforms,
                  content.platformId,
                )}
                key={content.id}
                onOpen={() => void openContent(content)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function SyncRunStatus({ run }: { run: PlatformContentSyncRun }) {
  const label =
    run.status === "completed"
      ? "同步完成"
      : run.status === "partial"
        ? "同步结果不完整"
        : "同步失败";
  return (
    <div
      class={`sync-run-status sync-${run.status}`}
      title={run.diagnostics.join("；") || undefined}
    >
      <strong>{label}</strong>
      <time>{formatTime(run.completedAt)}</time>
    </div>
  );
}

function PlatformContentRow({
  content,
  platformAvailable,
  onOpen,
}: {
  content: PlatformContentSnapshot;
  platformAvailable: boolean;
  onOpen(): void;
}) {
  return (
    <button
      class="platform-content-row"
      type="button"
      disabled={!content.contentUrl || !platformAvailable}
      aria-disabled={!content.contentUrl || !platformAvailable}
      tabIndex={content.contentUrl && platformAvailable ? 0 : -1}
      title={
        !platformAvailable
          ? "平台插件不可用，无法打开作品"
          : content.contentUrl
            ? "在浏览器中打开平台内容"
            : "该内容没有可用链接"
      }
      onClick={onOpen}
    >
      <div class="content-summary-cell">
        <PlatformContentCover content={content} />
        <span>
          <strong>
            {content.title ?? content.description ?? "未命名作品"}
          </strong>
          <small title={content.externalContentId}>
            {content.externalContentId}
          </small>
        </span>
      </div>
      <span class="platform-content-type">
        {contentTypeLabel(content.contentType)}
      </span>
      <div class="platform-content-metrics">
        <Metric label="播放" value={content.metrics.viewCount} />
        <Metric label="点赞" value={content.metrics.likeCount} />
        <Metric label="评论" value={content.metrics.commentCount} />
        <Metric label="收藏" value={content.metrics.collectCount} />
      </div>
      <span class="platform-content-status">
        {content.platformStatus ?? "—"}
      </span>
      <div class="content-time-cell">
        <strong>
          {content.publishedAt ? formatTime(content.publishedAt) : "—"}
        </strong>
        <small>采集 {formatTime(content.contentObservedAt)}</small>
      </div>
    </button>
  );
}

function contentTypeLabel(
  type: PlatformContentSnapshot["contentType"],
): string {
  return type === "video" ? "视频" : type === "image_text" ? "图文" : "未知";
}

function PlatformContentCover({
  content,
}: {
  content: PlatformContentSnapshot;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!content.coverUrl || failedUrl === content.coverUrl) {
    return (
      <span class="content-type-icon">
        <Icon name={content.contentType === "video" ? "video" : "image"} />
      </span>
    );
  }
  return (
    <img
      class="platform-content-cover"
      src={content.coverUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(content.coverUrl)}
    />
  );
}

function Metric({ label, value }: { label: string; value?: number }) {
  return (
    <span>
      <strong>
        {value === undefined
          ? "—"
          : new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(
              value,
            )}
      </strong>
      <small>{label}</small>
    </span>
  );
}

function EmptyContent({ title, detail }: { title: string; detail?: string }) {
  return (
    <div class="empty-state">
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}
