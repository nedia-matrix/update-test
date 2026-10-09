import type {
  PlatformAccountInfoKey,
  PlatformAccountView,
} from "@nedia-matrix/account-management";
import type { PlatformContentSnapshot } from "@nedia-matrix/platform-content";
import type { PlatformLoginEntrySummary } from "../../../bridge/contracts.js";
import { useEffect, useRef, useState } from "preact/hooks";

import type { AppContext } from "../app-context.js";
import { Icon } from "../components/icons.js";
import { PlatformIcon } from "../components/platform-icon.js";
import {
  accountStatus,
  errorMessage,
  formatTime,
  platformFor,
} from "../shared.js";
import { PlatformContentsPage } from "./platform-contents-page.js";

export function AccountsPage({
  context,
  account,
  onAccountsChanged,
}: {
  context: AppContext;
  account?: PlatformAccountView;
  onAccountsChanged(
    accounts: readonly PlatformAccountView[],
    preferredAccountId?: string,
  ): void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "contents">(
    "overview",
  );
  const [busyAction, setBusyAction] = useState<
    "open" | "refresh" | "contents" | "delete"
  >();
  const [contentRefreshToken, setContentRefreshToken] = useState(0);

  useEffect(() => setActiveTab("overview"), [account?.id]);

  if (!account) {
    return (
      <section class="empty-workspace account-empty-workspace">
        <span class="empty-workspace-icon">
          <Icon name="accounts" size={24} />
        </span>
        <h2>添加第一个平台账号</h2>
        <p>账号会显示在左侧，资料、内容和相关操作都从账号出发。</p>
      </section>
    );
  }

  const platform = platformFor(context.platforms, account.platformId);
  const accountName = account.nickname ?? account.displayName;
  const accountDescription = accountInformation(account, "desc");

  const runAction = async (action: "open" | "refresh" | "delete") => {
    setBusyAction(action);
    try {
      if (action === "open") {
        context.setStatus(`正在打开 ${accountName}…`, "busy");
        await window.matrix.openPlatformAccount({ accountId: account.id });
        context.setStatus("平台窗口已打开，账号信息将在识别后更新");
        return;
      }
      if (action === "refresh") {
        context.setStatus("正在从平台刷新账号资料…", "busy");
        await window.matrix.refreshPlatformAccountProfile({
          accountId: account.id,
        });
        const refreshed = await context.refreshAccounts();
        onAccountsChanged(refreshed, account.id);
        context.setStatus("账号资料已更新");
        return;
      }
      if (!globalThis.confirm(`删除“${accountName}”及其本地登录数据？`)) return;
      context.setStatus("正在删除账号和本地 Session…", "busy");
      await window.matrix.removePlatformAccount({ accountId: account.id });
      const refreshed = await context.refreshAccounts();
      onAccountsChanged(refreshed);
      context.setStatus("账号和本地 Session 已删除");
    } catch (error) {
      context.setStatus(errorMessage(error, "账号操作失败"), "error");
    } finally {
      setBusyAction(undefined);
    }
  };

  const synchronizeContents = async () => {
    setBusyAction("contents");
    context.setStatus("正在从平台同步作品和最新指标…", "busy");
    try {
      const run = await window.matrix.refreshPlatformContents({
        accountId: account.id,
      });
      setContentRefreshToken((current) => current + 1);
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
      setBusyAction(undefined);
    }
  };

  return (
    <div class="account-workspace">
      <header class="workspace-header account-profile-header">
        <AccountAvatar account={account} accountName={accountName} large />
        <div class="workspace-header-copy account-profile-copy">
          <div class="account-profile-name">
            <h1>{accountName}</h1>
            <span class={`status-badge account-${account.status}`}>
              <span class="badge-dot" aria-hidden="true" />
              {accountStatus(account)}
            </span>
          </div>
          <p>
            {platform?.displayName ?? account.platformId}
            <span aria-hidden="true"> · </span>
            {account.externalAccountId ?? "等待识别平台账号 ID"}
          </p>
          {accountDescription !== undefined && (
            <p class="account-profile-description">{accountDescription}</p>
          )}
        </div>
        <div class="workspace-header-actions account-profile-actions">
          <button
            class="secondary-button compact-button"
            type="button"
            disabled={busyAction !== undefined}
            onClick={() => void runAction("open")}
          >
            <Icon name="arrow-up-right" size={16} />
            打开平台
          </button>
          <button
            class="secondary-button compact-button"
            type="button"
            disabled={busyAction !== undefined}
            onClick={() => void runAction("refresh")}
          >
            <Icon name="refresh" size={16} />
            {busyAction === "refresh" ? "同步中" : "同步资料"}
          </button>
          <button
            class="secondary-button compact-button"
            type="button"
            disabled={
              busyAction !== undefined || account.status !== "authenticated"
            }
            onClick={() => void synchronizeContents()}
          >
            <Icon name="content" size={16} />
            {busyAction === "contents" ? "同步中" : "同步作品"}
          </button>
          <AccountActionMenu
            account={account}
            disabled={busyAction !== undefined}
            onDelete={() => void runAction("delete")}
          />
        </div>
      </header>

      <nav class="workspace-tabs account-tabs" aria-label="账号内容">
        <button
          class={activeTab === "overview" ? "active" : undefined}
          type="button"
          aria-current={activeTab === "overview" ? "page" : undefined}
          onClick={() => setActiveTab("overview")}
        >
          概览
        </button>
        <button
          class={activeTab === "contents" ? "active" : undefined}
          type="button"
          aria-current={activeTab === "contents" ? "page" : undefined}
          onClick={() => setActiveTab("contents")}
        >
          平台内容
        </button>
      </nav>

      {activeTab === "overview" ? (
        <AccountOverview
          account={account}
          context={context}
          refreshToken={contentRefreshToken}
        />
      ) : (
        <PlatformContentsPage
          context={context}
          fixedAccountId={account.id}
          refreshToken={contentRefreshToken}
        />
      )}
    </div>
  );
}

export function AddAccountDialog({
  context,
  onClose,
  onCreated,
}: {
  context: AppContext;
  onClose(): void;
  onCreated(accounts: readonly PlatformAccountView[], accountId: string): void;
}) {
  const [busyKey, setBusyKey] = useState<string>();

  const createAccount = async (
    platformId: string,
    platformName: string,
    loginEntry: PlatformLoginEntrySummary,
  ) => {
    const operationKey = `${platformId}:${loginEntry.id}`;
    setBusyKey(operationKey);
    context.setStatus(`正在创建 ${platformName} 独立 Session…`, "busy");
    try {
      const account = await window.matrix.createPlatformAccount({ platformId });
      const refreshed = await context.refreshAccounts();
      onCreated(refreshed, account.id);
      await window.matrix.openPlatformLogin({
        accountId: account.id,
        loginEntryId: loginEntry.id,
      });
      onClose();
      context.setStatus(
        `已打开 ${platformName} 登录窗口，登录成功后将自动识别账号`,
      );
    } catch (error) {
      context.setStatus(errorMessage(error, "创建账号失败"), "error");
    } finally {
      setBusyKey(undefined);
    }
  };

  return (
    <div class="dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        class="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header class="dialog-header">
          <div>
            <h2 id="add-account-title">添加账号</h2>
            <p>选择平台后，将打开独立的登录窗口。</p>
          </div>
          <button
            class="secondary-button compact-button"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
        </header>
        <div class="platform-grid dialog-platform-grid">
          {context.platforms.flatMap((platform) =>
            platform.loginEntries.map((entry) => {
              const operationKey = `${platform.id}:${entry.id}`;
              return (
                <button
                  class="platform-option"
                  type="button"
                  key={operationKey}
                  disabled={busyKey !== undefined}
                  onClick={() =>
                    void createAccount(platform.id, platform.displayName, entry)
                  }
                >
                  <PlatformIcon
                    platformId={platform.id}
                    platformName={platform.displayName}
                  />
                  <span>
                    <strong>{platform.displayName}</strong>
                    <small>
                      {busyKey === operationKey
                        ? "正在创建…"
                        : platform.loginEntries.length > 1
                          ? entry.displayName
                          : "连接新账号"}
                    </small>
                  </span>
                  <Icon name="arrow-up-right" size={16} />
                </button>
              );
            }),
          )}
        </div>
      </section>
    </div>
  );
}

function AccountOverview({
  account,
  context,
  refreshToken,
}: {
  account: PlatformAccountView;
  context: AppContext;
  refreshToken: number;
}) {
  const [contents, setContents] = useState<PlatformContentSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void window.matrix
      .listPlatformContents({ accountId: account.id })
      .then((result) => {
        if (active) setContents(result.items.slice(0, 4));
      })
      .catch((error) => {
        if (active)
          context.setStatus(errorMessage(error, "平台内容加载失败"), "error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [account.id, context, refreshToken]);

  const openContent = async (content: PlatformContentSnapshot) => {
    if (!content.contentUrl) return;
    try {
      await window.matrix.openPlatformContent({
        accountId: account.id,
        externalContentId: content.externalContentId,
      });
    } catch (error) {
      context.setStatus(errorMessage(error, "打开平台内容失败"), "error");
    }
  };

  return (
    <div class="account-overview">
      <section class="account-stat-grid" aria-label="账号数据概览">
        <AccountStat
          label="粉丝"
          value={accountInformation(account, "follower_count")}
        />
        <AccountStat
          label="获赞"
          value={accountInformation(account, "like_count")}
        />
        <AccountStat
          label="内容"
          value={accountInformation(account, "content_count")}
        />
      </section>
      <section class="data-surface account-recent-content">
        <header class="surface-header">
          <div>
            <h2>最近内容</h2>
            <p>该账号最近一次同步保存的平台作品。</p>
          </div>
        </header>
        {loading ? (
          <EmptyState title="正在加载平台内容…" />
        ) : contents.length === 0 ? (
          <EmptyState
            title="还没有平台内容"
            detail="切换到“平台内容”并执行同步。"
          />
        ) : (
          <div class="account-recent-grid">
            {contents.map((content) => (
              <button
                class="account-recent-card"
                type="button"
                key={content.id}
                aria-disabled={!content.contentUrl}
                tabIndex={content.contentUrl ? 0 : -1}
                title={
                  content.contentUrl
                    ? "在浏览器中打开平台内容"
                    : "该内容没有可用链接"
                }
                onClick={() => void openContent(content)}
              >
                <RecentContentCover content={content} />
                <span class="account-recent-card-body">
                  <span class="account-recent-card-heading">
                    <strong>
                      {content.title ?? content.description ?? "未命名作品"}
                    </strong>
                    <small>{contentTypeLabel(content.contentType)}</small>
                  </span>
                  <span class="account-recent-metrics">
                    <MetricValue
                      label="播放"
                      value={content.metrics.viewCount}
                    />
                    <MetricValue
                      label="点赞"
                      value={content.metrics.likeCount}
                    />
                    <MetricValue
                      label="评论"
                      value={content.metrics.commentCount}
                    />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RecentContentCover({ content }: { content: PlatformContentSnapshot }) {
  const [failed, setFailed] = useState(false);
  if (!content.coverUrl || failed) {
    return (
      <span class="account-recent-cover account-recent-cover-fallback">
        <Icon
          name={content.contentType === "video" ? "video" : "image"}
          size={22}
        />
      </span>
    );
  }
  return (
    <img
      class="account-recent-cover"
      src={content.coverUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function MetricValue({ label, value }: { label: string; value?: number }) {
  return (
    <span>
      <small>{label}</small>
      <strong>
        {value === undefined ? "—" : formatAccountInfoValue(value)}
      </strong>
    </span>
  );
}

function contentTypeLabel(
  type: PlatformContentSnapshot["contentType"],
): string {
  return type === "video" ? "视频" : type === "image_text" ? "图文" : "未知";
}

function AccountActionMenu({
  account,
  disabled,
  onDelete,
}: {
  account: PlatformAccountView;
  disabled: boolean;
  onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  return (
    <div class="action-menu" ref={menuRef}>
      <button
        class={`icon-button action-menu-trigger${open ? " active" : ""}`}
        type="button"
        disabled={disabled}
        aria-label={`更多 ${account.nickname ?? account.displayName} 操作`}
        aria-expanded={open}
        onClick={() => setOpen((visible) => !visible)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div class="action-menu-popover" role="menu">
          <button
            class="danger-menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Icon name="delete" size={15} />
            删除账号
          </button>
        </div>
      )}
    </div>
  );
}

export function AccountAvatar({
  account,
  accountName,
  large = false,
}: {
  account: PlatformAccountView;
  accountName: string;
  large?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const className = `account-avatar${large ? " account-avatar-large" : ""}`;
  if (!account.avatarUrl?.trim() || imageFailed) {
    return (
      <span class={`${className} account-avatar-fallback`} aria-hidden="true">
        {Array.from(accountName.trim())[0] ?? "账"}
      </span>
    );
  }
  return (
    <img
      class={className}
      src={account.avatarUrl.trim()}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setImageFailed(true)}
    />
  );
}

function AccountStat({
  label,
  value,
}: {
  label: string;
  value?: string | number;
}) {
  return (
    <div class="account-stat">
      <small>{label}</small>
      <strong>
        {value === undefined ? "—" : formatAccountInfoValue(value)}
      </strong>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div class="empty-state">
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}

function accountInformation(
  account: PlatformAccountView,
  key: PlatformAccountInfoKey,
): string | number | undefined {
  return account.accountInfo?.find((item) => item.key === key)?.value;
}

function formatAccountInfoValue(value: string | number): string {
  return typeof value === "number"
    ? new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(value)
    : value;
}
