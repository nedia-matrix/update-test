import type {
  PublicationTaskSummary,
  PublicationStatus,
} from "@nedia-matrix/publishing";
import type { PlatformContentSnapshot } from "@nedia-matrix/platform-content";
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { DiagnosticTraceRecord } from "../../../bridge/contracts.js";

import type { AppContext } from "../app-context.js";
import { Icon } from "../components/icons.js";
import {
  publicationComposeHref,
  publicationRecordsHref,
  type PublicationRecordFilters,
} from "../publishing-route.js";
import {
  accountLabel,
  errorMessage,
  formatTime,
  publicationDisplayGroupLabels,
  publicationDisplayGroupOrder,
  publicationStateLabels,
} from "../shared.js";

export function PublicationsPage({
  context,
  focusedPublicationId,
  active,
  filters,
  onFiltersChange,
  headerActionsTarget,
}: {
  context: AppContext;
  focusedPublicationId?: string;
  active: boolean;
  headerActionsTarget: HTMLDivElement | null;
  filters: PublicationRecordFilters;
  onFiltersChange(filters: PublicationRecordFilters): void;
}) {
  const [publications, setPublications] = useState(context.publications);
  const [focusedTask, setFocusedTask] = useState<PublicationTaskSummary | null>(
    null,
  );
  const [accounts, setAccounts] = useState(context.accounts);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { platformId, accountId, group, keyword } = filters;
  const setPlatformId = (platformId: string) =>
    onFiltersChange({ ...filters, platformId });
  const setAccountId = (accountId: string) =>
    onFiltersChange({ ...filters, accountId });
  const setGroup = (group: PublicationRecordFilters["group"]) =>
    onFiltersChange({ ...filters, group });
  const setKeyword = (keyword: string) =>
    onFiltersChange({ ...filters, keyword });
  const [tabCounts, setTabCounts] = useState(context.publicationTaskCounts);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const queryRequest = {
    view: "all" as const,
    platformId: platformId || undefined,
    accountId: accountId || undefined,
    group: group || undefined,
    keyword: keyword.trim() || undefined,
    limit: 50,
  };

  const loadPublications = async () => {
    const [refreshedAccounts, queryResult] = await Promise.all([
      context.refreshAccounts(),
      context.queryPublications(queryRequest),
    ]);
    setAccounts(refreshedAccounts);
    setPublications(queryResult.items);
    setNextCursor(queryResult.nextCursor);
    setTabCounts(queryResult.tabCounts);
    setTotal(queryResult.total);
  };

  useEffect(() => {
    if (!active) return;
    let subscribed = true;
    void Promise.all([
      context.refreshAccounts(),
      context.queryPublications(queryRequest),
    ])
      .then(([refreshedAccounts, queryResult]) => {
        if (!subscribed) return;
        setAccounts(refreshedAccounts);
        setPublications(queryResult.items);
        setNextCursor(queryResult.nextCursor);
        setTabCounts(queryResult.tabCounts);
        setTotal(queryResult.total);
      })
      .catch((error) =>
        context.setStatus(errorMessage(error, "发布记录加载失败"), "error"),
      )
      .finally(() => {
        if (subscribed) setLoading(false);
      });
    const stopPublishUpdates = context.onPublishUpdate(() => {
      void context
        .queryPublications({
          ...queryRequest,
        })
        .then((result) => {
          if (subscribed) {
            setPublications(result.items);
            setNextCursor(result.nextCursor);
            setTabCounts(result.tabCounts);
            setTotal(result.total);
          }
        });
    });
    const stopAccountUpdates = context.onAccountUpdate((refreshed) => {
      if (subscribed) setAccounts(refreshed);
    });
    return () => {
      subscribed = false;
      stopPublishUpdates();
      stopAccountUpdates();
    };
  }, [accountId, active, context, group, keyword, platformId]);

  useEffect(() => {
    if (!active) return;
    setFocusedTask(null);
    if (!focusedPublicationId) return;
    let subscribed = true;
    void window.matrix
      .getPublicationTask({ publicationId: focusedPublicationId })
      .then((task) => {
        if (!subscribed) return;
        if (!task) {
          context.setStatus("任务不存在或本地档案已删除", "error");
          return;
        }
        setPublications((current) =>
          current.some(({ id }) => id === task.id)
            ? current
            : [task, ...current],
        );
        setFocusedTask(task);
      })
      .catch((error) =>
        context.setStatus(errorMessage(error, "读取发布记录失败"), "error"),
      );
    return () => {
      subscribed = false;
    };
  }, [active, context, focusedPublicationId]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await context.queryPublications({
        ...queryRequest,
        cursor: nextCursor,
      });
      setPublications((current) => {
        const existing = new Set(current.map((publication) => publication.id));
        return [
          ...current,
          ...result.items.filter(
            (publication) => !existing.has(publication.id),
          ),
        ];
      });
      setNextCursor(result.nextCursor);
    } catch (error) {
      context.setStatus(errorMessage(error, "加载更多发布记录失败"), "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const pageItems =
    focusedTask && !publications.some(({ id }) => id === focusedTask.id)
      ? [focusedTask, ...publications]
      : publications;
  const filtered = pageItems;

  const counts = {
    action_required: tabCounts.actionRequired,
    attention_required: tabCounts.attentionRequired,
    in_progress: tabCounts.inProgress,
    completed: tabCounts.completed,
    closed: tabCounts.closed,
  };
  return (
    <div class="page-stack publication-task-page">
      {active &&
        headerActionsTarget &&
        createPortal(
          <button
            class="secondary-button compact-button"
            type="button"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              context.setStatus("正在刷新发布记录…", "busy");
              try {
                await loadPublications();
                context.setStatus("发布记录已刷新");
              } catch (error) {
                context.setStatus(errorMessage(error, "刷新失败"), "error");
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <Icon name="refresh" size={16} />
            {refreshing ? "刷新中" : "刷新"}
          </button>,
          headerActionsTarget,
        )}

      <section class="data-surface" aria-labelledby="content-list-title">
        <header class="surface-header">
          <div>
            <h2 id="content-list-title">
              {group
                ? `${publicationDisplayGroupLabels[group]}记录`
                : "全部记录"}
            </h2>
            <p>
              {group
                ? `${publicationDisplayGroupLabels[group]} · 共 ${total} 条，已加载 ${filtered.length} 条`
                : `全部记录 · 共 ${total} 条，已加载 ${publications.length} 条`}
            </p>
          </div>
          <div
            class="filter-controls publication-header-filters"
            aria-label="发布记录筛选"
          >
            <label>
              平台
              <select
                value={platformId}
                onChange={(event) => setPlatformId(event.currentTarget.value)}
              >
                <option value="">全部平台</option>
                {context.platforms.map((platform) => (
                  <option value={platform.id} key={platform.id}>
                    {platform.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              账号
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.currentTarget.value)}
              >
                <option value="">全部账号</option>
                {accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {accountLabel(account, context.platforms)}
                  </option>
                ))}
              </select>
            </label>
            <label class="publication-keyword-filter">
              搜索
              <input
                type="search"
                value={keyword}
                placeholder="标题或正文"
                onInput={(event) => setKeyword(event.currentTarget.value)}
              />
            </label>
          </div>
        </header>
        <div
          class="publication-group-tabs"
          role="group"
          aria-label="发布状态筛选"
        >
          <button
            class={!group ? "active" : undefined}
            type="button"
            aria-pressed={!group}
            onClick={() => setGroup("")}
          >
            全部 <span class="publication-tab-count">{tabCounts.all}</span>
          </button>
          {publicationDisplayGroupOrder.map((value) => (
            <button
              class={group === value ? "active" : undefined}
              type="button"
              aria-pressed={group === value}
              onClick={() => setGroup(value)}
              key={value}
            >
              {publicationDisplayGroupLabels[value]}
              <span class="publication-tab-count">{counts[value]}</span>
            </button>
          ))}
        </div>
        <div class="content-list-heading" aria-hidden="true">
          <span>内容</span>
          <span>平台 / 账号</span>
          <span>状态信息</span>
          <span>更新时间</span>
          <span>操作</span>
        </div>
        <div class="content-list" aria-live="polite">
          {loading ? (
            <EmptyContent title="正在加载发布记录…" />
          ) : filtered.length === 0 ? (
            <EmptyContent
              title={
                publications.length === 0
                  ? "还没有发布记录"
                  : "没有符合筛选条件的记录"
              }
              detail={
                publications.length === 0
                  ? "开始发布后，可在这里跟踪进度和查看结果。"
                  : "调整上方筛选条件或切换其他分组。"
              }
            />
          ) : (
            filtered.map((publication) => (
              <PublicationRow
                publication={publication}
                focused={active && publication.id === focusedPublicationId}
                accounts={accounts}
                context={context}
                onAttentionChanged={loadPublications}
                onRemoved={(publicationId) => {
                  setPublications((current) =>
                    current.filter(({ id }) => id !== publicationId),
                  );
                  if (focusedTask?.id === publicationId) {
                    setFocusedTask(null);
                    globalThis.location.hash = publicationRecordsHref(filters);
                  }
                }}
                key={publication.id}
              />
            ))
          )}
        </div>
        {nextCursor && (
          <div class="publication-load-more">
            <button
              class="secondary-button"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "正在加载…" : "加载更多"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function PublicationRow({
  publication,
  focused = false,
  accounts,
  context,
  onAttentionChanged,
  onRemoved,
}: {
  publication: PublicationTaskSummary;
  focused?: boolean;
  accounts: AppContext["accounts"];
  context: AppContext;
  onAttentionChanged(): Promise<void>;
  onRemoved(publicationId: string): void;
}) {
  const [expanded, setExpanded] = useState(focused);
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    const frame = requestAnimationFrame(() =>
      rowRef.current?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focused]);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [manualConfirmationOpen, setManualConfirmationOpen] = useState(false);
  const [contentSelectionOpen, setContentSelectionOpen] = useState(false);
  const [selectedWorkId, setSelectedWorkId] = useState("");
  const [workOptions, setWorkOptions] = useState<PlatformContentSnapshot[]>([]);
  const [loadingWorks, setLoadingWorks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [traceId, setTraceId] = useState<string | null | undefined>(undefined);
  const [traceRecords, setTraceRecords] = useState<
    readonly DiagnosticTraceRecord[] | null
  >(null);
  const [moreTraceRecords, setMoreTraceRecords] = useState(false);
  const [loadingMoreTraceRecords, setLoadingMoreTraceRecords] = useState(false);
  const account = accounts.find(({ id }) => id === publication.accountId);
  const platform = context.platforms.find(
    ({ id }) => id === publication.platformId,
  );
  const displayGroup = publication.effectiveDisplayGroup;
  const showWorkDetails = Boolean(
    publication.selectedPlatformContentId ||
    publication.manualPlatformContentId ||
    publication.platformContentId ||
    displayGroup === "completed",
  );
  const selectedWork = workOptions.find(
    (item) => item.externalContentId === selectedWorkId,
  );

  const [platformResult, setPlatformResult] = useState<Awaited<
    ReturnType<typeof window.matrix.getPublicationPlatformContent>
  > | null>(null);
  const [platformResultFailed, setPlatformResultFailed] = useState(false);
  useEffect(() => {
    if (
      !expanded ||
      displayGroup !== "completed" ||
      !(
        publication.platformContentId ||
        publication.manualPlatformContentId ||
        publication.selectedPlatformContentId
      )
    )
      return;
    let active = true;
    setPlatformResult(null);
    setPlatformResultFailed(false);
    void window.matrix
      .getPublicationPlatformContent({ publicationId: publication.id })
      .then((result) => {
        if (active) setPlatformResult(result);
      })
      .catch(() => {
        if (active) setPlatformResultFailed(true);
      });
    return () => {
      active = false;
    };
  }, [
    expanded,
    displayGroup,
    publication.id,
    publication.platformContentId,
    publication.manualPlatformContentId,
    publication.selectedPlatformContentId,
  ]);

  useEffect(() => {
    if (!manualConfirmationOpen && !contentSelectionOpen) return;
    let active = true;
    setLoadingWorks(true);
    void window.matrix
      .listPlatformContents({ accountId: publication.accountId })
      .then(({ items }) => {
        if (active)
          setWorkOptions(
            items.filter(
              (item) =>
                item.accountId === publication.accountId &&
                item.platformId === publication.platformId,
            ),
          );
      })
      .catch((error) => {
        if (active)
          context.setStatus(errorMessage(error, "读取平台作品失败"), "error");
      })
      .finally(() => {
        if (active) setLoadingWorks(false);
      });
    return () => {
      active = false;
    };
  }, [
    manualConfirmationOpen,
    contentSelectionOpen,
    publication.accountId,
    publication.platformId,
  ]);

  useEffect(() => {
    if (
      !diagnosticsExpanded ||
      traceId !== undefined ||
      !["failed", "uncertain"].includes(publication.state)
    ) {
      return;
    }
    let active = true;
    void window.matrix
      .findDiagnosticTrace({ publicationId: publication.id })
      .then(async (result) => {
        if (!active) return;
        const id = result?.traceId ?? null;
        setTraceId(id);
        if (id) {
          const records = await window.matrix.readDiagnosticTrace({
            traceId: id,
            limit: 500,
          });
          if (active) {
            setTraceRecords(records);
            setMoreTraceRecords(records.length === 500);
          }
        }
      })
      .catch(() => {
        if (active) {
          setTraceId(null);
          setTraceRecords(null);
        }
      });
    return () => {
      active = false;
    };
  }, [diagnosticsExpanded, publication.id, publication.state, traceId]);

  const runAction = async (
    action:
      | "copy"
      | "open"
      | "review"
      | "verify"
      | "acknowledge"
      | "confirm_published"
      | "select_content"
      | "confirm_not_published"
      | "reopen"
      | "open_snapshot"
      | "platform_account"
      | "export_diagnostics",
  ) => {
    setBusy(true);
    try {
      if (action === "copy") {
        const contentId =
          publication.selectedPlatformContentId ??
          publication.manualPlatformContentId ??
          publication.platformContentId;
        if (!contentId) return;
        await navigator.clipboard.writeText(contentId);
        context.setStatus("作品 ID 已复制");
      } else if (action === "review") {
        await window.matrix.openPublicationReview({
          publicationId: publication.id,
        });
      } else if (action === "verify" && account) {
        await window.matrix.openPlatformAccount({ accountId: account.id });
        context.setStatus("已打开平台账号，请先核实作品是否发布");
      } else if (action === "acknowledge") {
        await context.resolvePublicationAttention(
          publication.id,
          "acknowledged_failure",
        );
        await onAttentionChanged();
      } else if (action === "confirm_published") {
        const workId = selectedWorkId.trim();
        if (!workOptions.some((item) => item.externalContentId === workId))
          return;
        if (
          !globalThis.confirm(
            `确认作品 ${workId} 已在平台发布？此结论将标记为人工确认成功。`,
          )
        )
          return;
        await context.resolvePublicationAttention(
          publication.id,
          "confirmed_published",
          workId,
        );
        setManualConfirmationOpen(false);
        setSelectedWorkId("");
        await onAttentionChanged();
      } else if (action === "select_content") {
        const workId = selectedWorkId.trim();
        if (!workOptions.some((item) => item.externalContentId === workId))
          return;
        await window.matrix.selectPublicationContent({
          publicationId: publication.id,
          externalContentId: workId,
        });
        setContentSelectionOpen(false);
        setSelectedWorkId("");
        await onAttentionChanged();
      } else if (action === "confirm_not_published") {
        if (
          !globalThis.confirm(
            "请确认已在平台核实该作品未发布。确认后将允许以原内容重新创建发布记录。",
          )
        )
          return;
        await context.resolvePublicationAttention(
          publication.id,
          "confirmed_not_published",
        );
        await onAttentionChanged();
      } else if (action === "reopen") {
        await context.reopenPublicationAttention(publication.id);
        await onAttentionChanged();
      } else if (action === "open") {
        await window.matrix.openPublication({ publicationId: publication.id });
      } else if (
        action === "open_snapshot" &&
        account &&
        platformResult?.content
      ) {
        await window.matrix.openPlatformContent({
          accountId: account.id,
          externalContentId: platformResult.content.externalContentId,
        });
      } else if (action === "platform_account" && account) {
        await window.matrix.openPlatformAccount({ accountId: account.id });
      } else if (action === "export_diagnostics" && traceId) {
        const result = await window.matrix.exportDiagnosticTrace({ traceId });
        if (result.exported) context.setStatus("诊断包已导出");
      }
    } catch (error) {
      context.setStatus(errorMessage(error, "内容操作失败"), "error");
    } finally {
      setBusy(false);
    }
  };

  const recreateDraft = async () => {
    setBusy(true);
    try {
      const draft = await window.matrix.recreatePublicationDraft({
        publicationId: publication.id,
      });
      context.setRecreatedDraft(draft);
      globalThis.location.hash = publicationComposeHref;
    } catch (error) {
      context.setStatus(errorMessage(error, "创建预填草稿失败"), "error");
    } finally {
      setBusy(false);
    }
  };
  const removeRecord = async () => {
    if (
      !globalThis.confirm(
        "删除本机发布记录和未被其他记录使用的素材副本，不会删除平台作品。是否继续？",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await window.matrix.removePublicationArchiveRecord({
        publicationId: publication.id,
      });
      context.setStatus(
        result.failedAssetCount
          ? `已删除记录并回收 ${formatBytes(result.reclaimedBytes)}；${result.failedAssetCount} 个素材清理失败，可稍后重试`
          : "已删除记录，回收 " + formatBytes(result.reclaimedBytes),
      );
      onRemoved(publication.id);
      await onAttentionChanged();
    } catch (error) {
      context.setStatus(errorMessage(error, "删除记录失败"), "error");
    } finally {
      setBusy(false);
    }
  };
  const selectContent = (manualConfirmation: boolean) => {
    setExpanded(true);
    setSelectedWorkId("");
    setManualConfirmationOpen(manualConfirmation);
    setContentSelectionOpen(!manualConfirmation);
  };
  const unresolved =
    publication.state === "uncertain" &&
    publication.attentionResolution === null;
  const contentId =
    publication.selectedPlatformContentId ??
    publication.manualPlatformContentId ??
    publication.platformContentId;
  const latestTransition = publication.transitions.at(-1);
  const latestMessage =
    publication.lastMessage?.trim() || latestTransition?.reason?.trim();
  const manuallyPublished =
    publication.attentionResolution === "confirmed_published";
  const outcomeLabel = manuallyPublished
    ? "人工确认成功"
    : publication.attentionResolution === "confirmed_not_published"
      ? "已确认未发布"
      : publicationStatusText(publication.state);
  const recordActions: Array<{
    label: string;
    visible: boolean;
    quick?: boolean;
    primary?: boolean;
    destructive?: boolean;
    run(): void | Promise<void>;
  }> = [
    {
      label: "打开任务页面",
      visible: [
        "preparing",
        "awaiting_confirmation",
        "submitting",
        "verifying",
      ].includes(publication.state),
      quick: true,
      primary: true,
      run: () => runAction("review"),
    },
    {
      label: "打开作品",
      visible:
        displayGroup === "completed" &&
        Boolean(
          publication.selectedPlatformContentId ||
          publication.manualPlatformContentId ||
          publication.platformContentUrl,
        ),
      quick: true,
      primary: true,
      run: () => runAction("open"),
    },
    {
      label: "标记已处理",
      visible:
        publication.state === "failed" &&
        publication.attentionResolution === null,
      primary: true,
      run: () => runAction("acknowledge"),
    },
    {
      label: "确认已发布",
      visible: unresolved,
      quick: true,
      primary: !account,
      run: () => selectContent(true),
    },
    {
      label: "确认未发布",
      visible: unresolved,
      run: () => runAction("confirm_not_published"),
    },
    {
      label: "前往平台核实",
      visible: unresolved && Boolean(account),
      primary: true,
      run: () => runAction("verify"),
    },
    {
      label:
        publication.attentionResolution === "confirmed_published"
          ? "重新标记需核实"
          : "重新标记需处理",
      visible:
        ["failed", "uncertain"].includes(publication.state) &&
        publication.attentionResolution !== null,
      run: () => runAction("reopen"),
    },
    {
      label: "重新创建",
      visible:
        ["failed", "cancelled", "rejected"].includes(publication.state) ||
        (publication.state === "uncertain" &&
          publication.attentionResolution === "confirmed_not_published"),
      quick: true,
      primary:
        publication.state !== "failed" ||
        publication.attentionResolution !== null,
      run: recreateDraft,
    },
    {
      label: "复制为新草稿",
      visible: publication.state === "published",
      run: recreateDraft,
    },
    {
      label: "从平台作品中选择",
      visible: displayGroup === "completed",
      run: () => selectContent(false),
    },
    {
      label: "打开平台快照作品",
      visible:
        displayGroup === "completed" &&
        Boolean(
          account &&
          platformResult?.content &&
          !publication.selectedPlatformContentId &&
          !publication.manualPlatformContentId,
        ),
      run: () => runAction("open_snapshot"),
    },
    {
      label: "前往平台账号",
      visible:
        displayGroup === "completed" &&
        Boolean(
          account &&
          (platformResult || platformResultFailed) &&
          !platformResult?.content,
        ),
      run: () => runAction("platform_account"),
    },
    {
      label: "导出诊断包",
      visible: diagnosticsExpanded && Boolean(traceId),
      run: () => runAction("export_diagnostics"),
    },
    {
      label: "删除记录",
      visible: publication.archiveRemovable,
      destructive: true,
      run: removeRecord,
    },
  ]
    .filter((action) => action.visible)
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));

  return (
    <article
      ref={rowRef}
      class={`content-record${expanded ? " expanded" : ""}${focused ? " focused-publication" : ""}`}
    >
      <div class="content-summary-cell">
        <span class="content-type-icon">
          <Icon
            name={publication.contentForm === "video" ? "video" : "image"}
            size={17}
          />
        </span>
        <span>
          <strong>{publication.title?.trim() || "无标题内容"}</strong>
          <small>
            {publication.body.trim() ||
              publication.assets.map(({ name }) => name).join("，") ||
              "暂无正文"}
          </small>
        </span>
      </div>
      <div class="content-account-cell">
        <strong>{platform?.displayName ?? publication.platformId}</strong>
        <small>
          {account
            ? (account.nickname ?? account.displayName)
            : "账号信息不可用"}
        </small>
      </div>
      <div>
        <span
          class={`status-badge publication-${publication.attentionResolution === "confirmed_published" ? "manual" : publication.state}`}
        >
          <span class="badge-dot" aria-hidden="true" />
          {publication.attentionResolution === "confirmed_published"
            ? "人工确认"
            : publicationStatusText(publication.state)}
        </span>
      </div>
      <div class="content-time-cell">
        <strong>{formatTime(publication.updatedAt)}</strong>
        <small>创建于 {formatTime(publication.createdAt)}</small>
      </div>
      <div class="row-actions">
        {!expanded &&
          recordActions
            .filter((action) => action.quick)
            .map((action) => (
              <button
                class="secondary-button small-button"
                type="button"
                key={action.label}
                disabled={busy}
                onClick={() => void action.run()}
              >
                {action.label}
              </button>
            ))}
        <button
          class="icon-button"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "收起内容详情" : "展开内容详情"}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="chevron-down" />
        </button>
      </div>

      {expanded && (
        <div class="content-record-details">
          <section
            class={`publication-task-outcome${manuallyPublished ? " publication-task-outcome-success" : ""}`}
            aria-label="当前任务状态"
          >
            <div class="publication-outcome-heading">
              <strong>{outcomeLabel}</strong>
              <time>{formatTime(publication.updatedAt)}</time>
            </div>
            {publication.attentionResolution && (
              <p class="publication-resolution-summary">
                {manuallyPublished
                  ? "人工确认已完成"
                  : attentionResolutionLabel(publication.attentionResolution)}
                {publication.attentionResolvedAt
                  ? ` · ${formatTime(publication.attentionResolvedAt)}`
                  : ""}
                <span class="publication-original-state">
                  原始执行状态：{publicationStateLabels[publication.state]}
                </span>
              </p>
            )}
            {latestMessage &&
              latestMessage !== publicationStateLabels[publication.state] && (
                <p class="publication-latest-message">
                  {publication.attentionResolution && "原始执行消息："}
                  {latestMessage}
                </p>
              )}
          </section>
          <section class="publication-detail-action-area" aria-label="记录操作">
            <div
              class="publication-detail-toolbar"
              role="group"
              aria-label="记录操作按钮"
            >
              <span>操作</span>
              {recordActions.map((action) => (
                <button
                  class={`${action.primary ? "" : "secondary-button "}small-button${action.destructive ? " publication-delete-action" : ""}`}
                  type="button"
                  key={action.label}
                  disabled={busy}
                  onClick={() => void action.run()}
                >
                  {action.label}
                </button>
              ))}
            </div>
            {(manualConfirmationOpen || contentSelectionOpen) && (
              <form
                class="manual-confirmation-form publication-detail-selection"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAction(
                    manualConfirmationOpen
                      ? "confirm_published"
                      : "select_content",
                  );
                }}
              >
                <label>
                  选择该账号的平台作品
                  <select
                    value={selectedWorkId}
                    required
                    disabled={loadingWorks || busy}
                    onChange={(event) =>
                      setSelectedWorkId(event.currentTarget.value)
                    }
                  >
                    <option value="">请选择作品</option>
                    {workOptions.map((item) => (
                      <option value={item.externalContentId} key={item.id}>
                        {item.title ?? "无标题作品"} · {item.externalContentId}{" "}
                        ·
                        {formatTime(item.publishedAt ?? item.contentObservedAt)}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedWork?.coverUrl && (
                  <img
                    class="platform-content-cover"
                    src={selectedWork.coverUrl}
                    alt="所选平台作品封面"
                  />
                )}
                <small>
                  {loadingWorks
                    ? "正在读取本机平台作品快照…"
                    : workOptions.length
                      ? "请核对标题、发布时间和作品 ID。"
                      : "该账号尚无本机作品快照，请先同步。"}
                </small>
                <div class="attention-resolution-actions">
                  <button
                    class="secondary-button small-button"
                    type="button"
                    disabled={busy || loadingWorks}
                    onClick={async () => {
                      setLoadingWorks(true);
                      try {
                        await window.matrix.refreshPlatformContents({
                          accountId: publication.accountId,
                        });
                        const { items } =
                          await window.matrix.listPlatformContents({
                            accountId: publication.accountId,
                          });
                        setWorkOptions(
                          items.filter(
                            (item) =>
                              item.platformId === publication.platformId,
                          ),
                        );
                      } catch (error) {
                        context.setStatus(
                          errorMessage(error, "同步平台作品失败"),
                          "error",
                        );
                      } finally {
                        setLoadingWorks(false);
                      }
                    }}
                  >
                    同步作品
                  </button>
                  <button
                    class="small-button"
                    type="submit"
                    disabled={busy || loadingWorks || !selectedWork}
                  >
                    {manualConfirmationOpen ? "确认成功" : "保存选择"}
                  </button>
                  <button
                    class="text-button"
                    type="button"
                    onClick={() => {
                      setManualConfirmationOpen(false);
                      setContentSelectionOpen(false);
                      setSelectedWorkId("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
          </section>
          <div
            class={`publication-detail-main${showWorkDetails ? "" : " publication-detail-main-single"}`}
          >
            <section class="content-detail-block publication-detail-input">
              <h3>发布内容</h3>
              <strong>{publication.title?.trim() || "无标题内容"}</strong>
              <p class="publication-detail-body">
                {publication.body.trim() || "暂无正文"}
              </p>
              <dl class="publication-detail-facts">
                <div>
                  <dt>内容形式</dt>
                  <dd>
                    {publication.contentForm === "video" ? "视频" : "图文"}
                  </dd>
                </div>
                <div>
                  <dt>规则版本</dt>
                  <dd>{publication.rulesVersion}</dd>
                </div>
                <div>
                  <dt>标签</dt>
                  <dd>{publication.tags?.join("、") || "无"}</dd>
                </div>
                <div>
                  <dt>素材</dt>
                  <dd>
                    {publication.assets.length ? (
                      <details class="publication-assets-details">
                        <summary>
                          {publication.assets.length} 个 ·{" "}
                          {formatBytes(
                            publication.assets.reduce(
                              (total, asset) => total + asset.size,
                              0,
                            ),
                          )}
                        </summary>
                        <ul>
                          {publication.assets.map((asset, index) => (
                            <li key={index}>
                              <span>{asset.name}</span>
                              <small>{formatBytes(asset.size)}</small>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      "无"
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            {showWorkDetails && (
              <section class="content-detail-block publication-detail-result">
                <h3>作品结果</h3>
                <div class="publication-content-id">
                  <span>作品 ID</span>
                  <strong>{contentId ?? "尚未生成"}</strong>
                  {contentId && (
                    <button
                      class="icon-button"
                      type="button"
                      disabled={busy}
                      aria-label="复制作品 ID"
                      title="复制作品 ID"
                      onClick={() => void runAction("copy")}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                  )}
                </div>
                {publication.selectedPlatformContentId &&
                  publication.platformContentId &&
                  publication.selectedPlatformContentId !==
                    publication.platformContentId && (
                    <small class="publication-original-id">
                      程序原始观测 ID：{publication.platformContentId}
                    </small>
                  )}
                {displayGroup === "completed" && contentId && (
                  <PlatformContentDetails
                    publication={publication}
                    result={platformResult}
                    failed={platformResultFailed}
                  />
                )}
              </section>
            )}
          </div>
          <details class="publication-detail-history publication-status-history">
            <summary>
              <span class="publication-status-heading">
                历史记录
                <small>
                  {publication.transitions.length +
                    publication.attentionHistory.length}
                </small>
              </span>
            </summary>
            <div class="publication-history-body">
              <h4>状态变更</h4>
              {publication.transitions.length ? (
                <ol class="publication-status-timeline">
                  {publication.transitions.map((transition, index) => (
                    <li key={`${transition.occurredAt}:${index}`}>
                      <strong>{publicationStateLabels[transition.to]}</strong>
                      <time>{formatTime(transition.occurredAt)}</time>
                      {transition.reason && <p>{transition.reason}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>暂无状态变更记录</p>
              )}
              {publication.attentionHistory.length > 0 && (
                <>
                  <h4>人工处理</h4>
                  <ol class="publication-status-timeline">
                    {publication.attentionHistory.map((event, index) => (
                      <li key={index}>
                        <strong>
                          {event.reopened
                            ? "重新打开"
                            : attentionResolutionLabel(event.resolution)}
                        </strong>
                        <time>{formatTime(event.resolvedAt)}</time>
                        {event.manualPlatformContentId && (
                          <p>作品 ID：{event.manualPlatformContentId}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          </details>
          {["failed", "uncertain"].includes(publication.state) && (
            <details
              class="publication-detail-history publication-detail-diagnostics"
              onToggle={(event) =>
                setDiagnosticsExpanded(event.currentTarget.open)
              }
            >
              <summary>诊断详情</summary>
              {diagnosticsExpanded && (
                <div>
                  <span>诊断编号</span>
                  <p>
                    {traceId === undefined
                      ? "正在查询…"
                      : traceId
                        ? traceId
                        : "诊断日志已过期或不可用"}
                  </p>
                  {traceId && (
                    <div class="diagnostic-actions">
                      <button
                        class="text-button"
                        type="button"
                        onClick={async () => {
                          await navigator.clipboard.writeText(traceId);
                          context.setStatus("诊断编号已复制");
                        }}
                      >
                        <Icon name="copy" size={14} />
                        复制编号
                      </button>
                    </div>
                  )}
                  {traceId && traceRecords === null && (
                    <p>正在读取诊断时间线…</p>
                  )}
                  {traceRecords && (
                    <>
                      <ol class="diagnostic-timeline">
                        {traceRecords.map((record) => (
                          <li key={record.eventId}>
                            <time>{formatTime(record.timestamp)}</time>
                            <strong>{record.event}</strong>
                            {typeof record.details?.message === "string" && (
                              <small>{record.details.message}</small>
                            )}
                            {record.attachmentIds?.map((attachmentId) => (
                              <DiagnosticAttachmentView
                                key={attachmentId}
                                traceId={record.traceId}
                                attachmentId={attachmentId}
                              />
                            ))}
                          </li>
                        ))}
                      </ol>
                      {moreTraceRecords && (
                        <button
                          class="text-button"
                          type="button"
                          disabled={loadingMoreTraceRecords}
                          onClick={async () => {
                            if (!traceId || !traceRecords.length) return;
                            setLoadingMoreTraceRecords(true);
                            try {
                              const next =
                                await window.matrix.readDiagnosticTrace({
                                  traceId,
                                  limit: 500,
                                  afterSequence:
                                    traceRecords[traceRecords.length - 1]!
                                      .sequence,
                                });
                              setTraceRecords([...traceRecords, ...next]);
                              setMoreTraceRecords(next.length === 500);
                            } catch (error) {
                              context.setStatus(
                                errorMessage(error, "读取诊断时间线失败"),
                                "error",
                              );
                            } finally {
                              setLoadingMoreTraceRecords(false);
                            }
                          }}
                        >
                          加载更多诊断事件
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function PlatformContentDetails({
  publication,
  result,
  failed,
}: {
  publication: PublicationTaskSummary;
  result: Awaited<
    ReturnType<typeof window.matrix.getPublicationPlatformContent>
  > | null;
  failed: boolean;
}) {
  const content = result?.content;
  return (
    <div class="publication-detail-platform">
      <h4>平台同步快照</h4>
      {result?.accountMissing ? (
        <p>原发布账号已删除，无法读取本地平台快照。</p>
      ) : failed ? (
        <p>读取本地平台快照失败。</p>
      ) : !result ? (
        <p>正在读取本地同步快照…</p>
      ) : content ? (
        <>
          <div class="publication-platform-snapshot">
            {content.coverUrl && (
              <img
                class="platform-content-cover"
                src={content.coverUrl}
                alt="平台作品封面"
              />
            )}
            <div>
              <strong>{content.title ?? "无标题作品"}</strong>
              <small>快照同步于 {formatTime(content.contentObservedAt)}</small>
              {content.platformStatus && (
                <p>平台状态：{content.platformStatus}</p>
              )}
              <p>
                {metricSummary(content.metrics)}
                {content.metricsObservedAt
                  ? " · 指标于 " +
                    formatTime(content.metricsObservedAt) +
                    " 观测"
                  : ""}
              </p>
            </div>
          </div>
          {(publication.selectedPlatformContentId ||
            publication.manualPlatformContentId) &&
            (content.contentUrl ? (
              <PublicationContentAddress
                label="当前作品地址"
                value={content.contentUrl}
              />
            ) : (
              <p>快照未提供作品地址</p>
            ))}
          {!publication.selectedPlatformContentId &&
            !publication.manualPlatformContentId &&
            publication.platformContentUrl && (
              <PublicationContentAddress
                label="程序观测地址"
                value={publication.platformContentUrl}
              />
            )}
          {result.latestRun?.status !== "completed" && (
            <p class="publication-snapshot-note">
              最近一次同步可能不完整（
              {result.latestRun?.status ?? "暂无成功同步"}）。
            </p>
          )}
          {!publication.selectedPlatformContentId &&
            !publication.manualPlatformContentId &&
            publication.platformContentUrl &&
            content.contentUrl &&
            content.contentUrl !== publication.platformContentUrl && (
              <p class="publication-snapshot-note">
                平台快照 URL 与发布结果 URL 不同；打开作品仍使用发布结果 URL。
              </p>
            )}
        </>
      ) : (
        <p>尚未同步到该作品。</p>
      )}
    </div>
  );
}

function PublicationContentAddress({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <details class="publication-content-address">
      <summary>
        <span>{label}</span>
        <span class="publication-address-preview" title={value}>
          {value}
        </span>
      </summary>
      <p>{value}</p>
    </details>
  );
}

function metricSummary(
  metrics: Awaited<
    ReturnType<typeof window.matrix.getPublicationPlatformContent>
  >["content"] extends infer T
    ? T extends { metrics: infer M }
      ? M
      : never
    : never,
): string {
  const labels: Array<[string, number | undefined]> = [
    ["播放", metrics.viewCount],
    ["点赞", metrics.likeCount],
    ["评论", metrics.commentCount],
    ["分享", metrics.shareCount],
    ["收藏", metrics.collectCount],
  ];
  const values = labels.filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  return values.length
    ? values
        .map(([label, count]) => label + " " + count.toLocaleString())
        .join(" · ")
    : "暂无指标";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GiB";
}

function publicationStatusText(state: PublicationStatus): string {
  switch (state) {
    case "awaiting_confirmation":
      return "待人工发布";
    case "uncertain":
      return "需核实作品";
    case "failed":
      return "发布失败";
    case "published":
      return "发布成功";
    case "cancelled":
      return "任务已取消";
    case "rejected":
      return "请求被拒绝";
    case "draft":
    case "validated":
    case "scheduled":
    case "preparing":
    case "submitting":
    case "verifying":
    case "retrying":
      return publicationStateLabels[state];
  }
}

function DiagnosticAttachmentView({
  traceId,
  attachmentId,
}: {
  traceId: string;
  attachmentId: string;
}) {
  const [source, setSource] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void window.matrix
      .readDiagnosticAttachment({ traceId, attachmentId })
      .then((attachment) => {
        if (active)
          setSource(
            attachment
              ? `data:${attachment.mimeType};base64,${attachment.dataBase64}`
              : null,
          );
      })
      .catch(() => {
        if (active) setSource(null);
      });
    return () => {
      active = false;
    };
  }, [attachmentId, traceId]);
  if (source === undefined) return <small>正在读取诊断截图…</small>;
  if (source === null) return <small>诊断截图已过期或不可用</small>;
  return (
    <div class="diagnostic-attachment">
      <img src={source} alt={`诊断截图 ${attachmentId}`} />
    </div>
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

function attentionResolutionLabel(value: string | null): string {
  switch (value) {
    case "acknowledged_failure":
      return "失败已了解";
    case "recreated":
      return "已创建新任务";
    case "confirmed_published":
      return "已确认平台发布";
    case "confirmed_not_published":
      return "已确认未发布";
    case "dismissed":
      return "已忽略";
    default:
      return "已处理";
  }
}
