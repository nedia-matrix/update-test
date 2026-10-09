import type { PlatformAccountView } from "@nedia-matrix/account-management";
import { useEffect, useMemo, useState } from "preact/hooks";

import type { AppContext, AppStatus } from "./app-context.js";
import { GlobalStatus } from "./components/global-status.js";
import { Icon, type IconName } from "./components/icons.js";
import { PlatformIcon } from "./components/platform-icon.js";
import { AccountsPage, AddAccountDialog } from "./pages/accounts-page.js";
import { PublishingPage } from "./pages/publishing-page.js";
import { SettingsPage } from "./pages/settings-page.js";
import { accountStatus, platformFor } from "./shared.js";
import { applyTheme, resolveTheme, type ThemePreference } from "./theme.js";

interface RouteDefinition {
  path: string;
  title: string;
  icon: IconName;
}

const routes: readonly RouteDefinition[] = [
  {
    path: "/accounts",
    title: "平台账号",
    icon: "accounts",
  },
  {
    path: "/publish",
    title: "内容发布",
    icon: "publish",
  },
  {
    path: "/settings",
    title: "设置",
    icon: "settings",
  },
];

const selectedAccountStorageKey = "nedia-matrix:selected-account";

interface RuntimeSummary {
  version: string | null;
  status: "loading" | "running" | "stopped" | "unknown";
  host: "127.0.0.1" | null;
  port: number | null;
}

export function App({
  context,
  initialThemePreference,
}: {
  context: AppContext;
  initialThemePreference: ThemePreference;
}) {
  const [routePath, setRoutePath] = useState(routeFromHash);
  const [accounts, setAccounts] = useState<readonly PlatformAccountView[]>(
    context.accounts,
  );
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState(
    () => globalThis.localStorage.getItem(selectedAccountStorageKey) ?? "",
  );
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [status, setStatus] = useState<AppStatus>(context.currentStatus());
  const [statusVisible, setStatusVisible] = useState(true);
  const [themePreference, setThemePreference] = useState(
    initialThemePreference,
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => globalThis.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [runtime, setRuntime] = useState<RuntimeSummary>({
    version: null,
    status: "loading",
    host: null,
    port: null,
  });
  const [runtimeActionPending, setRuntimeActionPending] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const route = useMemo(
    () => routes.find(({ path }) => path === routePath) ?? routes[0]!,
    [routePath],
  );
  const resolvedTheme = resolveTheme(themePreference, systemPrefersDark);
  const selectedAccount = accounts.find(({ id }) => id === selectedAccountId);

  useEffect(() => {
    const updateRoute = () => {
      setRoutePath(routeFromHash());
    };
    globalThis.addEventListener("hashchange", updateRoute);
    if (!globalThis.location.hash) globalThis.location.hash = "/accounts";
    return () => globalThis.removeEventListener("hashchange", updateRoute);
  }, []);

  useEffect(() => context.onStatusUpdate(setStatus), [context]);

  useEffect(() => {
    let active = true;
    void context
      .refreshAccounts()
      .then((refreshed) => {
        if (active) setAccounts(refreshed);
      })
      .catch(() => context.setStatus("账号加载失败", "error"))
      .finally(() => {
        if (active) setAccountsLoaded(true);
      });
    const stopUpdates = context.onAccountUpdate((refreshed) => {
      if (active) setAccounts(refreshed);
    });
    return () => {
      active = false;
      stopUpdates();
    };
  }, [context]);

  useEffect(() => {
    if (!accountsLoaded) return;
    if (
      selectedAccount &&
      accounts.some(({ id }) => id === selectedAccount.id)
    ) {
      return;
    }
    const fallback =
      accounts.find(
        ({ status: accountState }) => accountState === "authenticated",
      ) ?? accounts[0];
    setSelectedAccountId(fallback?.id ?? "");
  }, [accounts, accountsLoaded, selectedAccount]);

  useEffect(() => {
    if (selectedAccountId) {
      globalThis.localStorage.setItem(
        selectedAccountStorageKey,
        selectedAccountId,
      );
    } else {
      globalThis.localStorage.removeItem(selectedAccountStorageKey);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    setStatusVisible(true);
    if (status.kind === "error") return;
    const timeout = globalThis.setTimeout(() => setStatusVisible(false), 5_000);
    return () => globalThis.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    media.addEventListener("change", updateSystemTheme);
    return () => media.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    let active = true;
    const refreshRuntime = async () => {
      try {
        const summary = await window.matrix.getLocalRuntimeStatus();
        if (active) setRuntime(summary);
      } catch {
        if (active) {
          setRuntime({
            version: null,
            status: "unknown",
            host: null,
            port: null,
          });
        }
      }
    };
    void refreshRuntime();
    const interval = globalThis.setInterval(() => void refreshRuntime(), 2_000);
    return () => {
      active = false;
      globalThis.clearInterval(interval);
    };
  }, []);

  const setRuntimeRunning = async (running: boolean) => {
    setRuntimeActionPending(true);
    setRuntimeError(null);
    try {
      const summary = await window.matrix.setLocalRuntimeRunning({ running });
      setRuntime(summary);
      context.setStatus(running ? "本地服务已启动" : "本地服务已关闭");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(message);
      context.setStatus(
        running ? "本地服务启动失败" : "本地服务关闭失败",
        "error",
      );
    } finally {
      setRuntimeActionPending(false);
    }
  };

  useEffect(() => {
    // Main retains the result even while the settings page is unmounted.
    void window.matrix.checkForApplicationUpdate().catch(() => undefined);
  }, []);

  const updateAccounts = (
    refreshed: readonly PlatformAccountView[],
    preferredAccountId?: string,
  ) => {
    setAccounts(refreshed);
    if (preferredAccountId) setSelectedAccountId(preferredAccountId);
  };

  return (
    <div class="app-shell">
      <main class="app-main">
        <aside class="sidebar">
          <div class="account-sidebar-header">
            <strong>平台账号</strong>
            <button
              class="icon-button"
              type="button"
              aria-label="添加平台账号"
              title="添加平台账号"
              onClick={() => setShowAddAccount(true)}
            >
              <Icon name="add" />
            </button>
          </div>

          <nav class="account-navigation" aria-label="账号列表">
            {accounts.map((account) => {
              const accountName = account.nickname ?? account.displayName;
              const platform = platformFor(
                context.platforms,
                account.platformId,
              );
              const active =
                route.path === "/accounts" && account.id === selectedAccountId;
              return (
                <button
                  class={active ? "active" : undefined}
                  type="button"
                  key={account.id}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    setSelectedAccountId(account.id);
                    globalThis.location.hash = "/accounts";
                  }}
                >
                  <PlatformIcon
                    platformId={account.platformId}
                    platformName={platform?.displayName ?? account.platformId}
                  />
                  <span class="sidebar-account-copy">
                    <strong>{accountName}</strong>
                    <small>
                      {account.profileSyncedAt
                        ? `${formatSidebarSyncTime(account.profileSyncedAt)} 同步`
                        : "尚未同步"}
                    </small>
                  </span>
                  <span class="sidebar-account-status">
                    <span
                      class={`sidebar-account-dot account-${account.status}`}
                      aria-hidden="true"
                    />
                    <small>{accountStatus(account)}</small>
                  </span>
                </button>
              );
            })}
            {accountsLoaded && accounts.length === 0 && (
              <button
                class="sidebar-empty-account"
                type="button"
                onClick={() => setShowAddAccount(true)}
              >
                <Icon name="add" size={16} />
                添加第一个账号
              </button>
            )}
          </nav>

          <footer class="sidebar-status-bar">
            <span class="sidebar-version" title="应用版本">
              {runtime.version ? `v${runtime.version}` : "v—"}
            </span>
            <nav class="primary-navigation" aria-label="全局功能">
              {routes.slice(1).map((item) => (
                <NavigationLink item={item} active={item.path === route.path} />
              ))}
            </nav>
          </footer>
        </aside>

        <section class="workspace" key={route.path}>
          {statusVisible && (
            <GlobalStatus
              status={status}
              onDismiss={() => setStatusVisible(false)}
            />
          )}
          {route.path === "/accounts" ? (
            <AccountsPage
              context={context}
              account={selectedAccount}
              onAccountsChanged={updateAccounts}
            />
          ) : route.path === "/publish" ? (
            <PublishingPage
              context={context}
              preferredAccountId={selectedAccountId}
            />
          ) : (
            <SettingsPage
              context={context}
              themePreference={themePreference}
              onThemePreferenceChange={(theme) => {
                void window.matrix
                  .updatePreferences({ appearance: { theme } })
                  .then((preferences) =>
                    setThemePreference(preferences.appearance.theme),
                  )
                  .catch(() =>
                    context.setStatus("外观设置保存失败，请重试", "error"),
                  );
              }}
              resolvedTheme={resolvedTheme}
              runtime={runtime}
              runtimeActionPending={runtimeActionPending}
              runtimeError={runtimeError}
              onRuntimeRunningChange={setRuntimeRunning}
            />
          )}
        </section>
      </main>

      {showAddAccount && (
        <AddAccountDialog
          context={context}
          onClose={() => setShowAddAccount(false)}
          onCreated={(refreshed, accountId) => {
            updateAccounts(refreshed, accountId);
            globalThis.location.hash = "/accounts";
          }}
        />
      )}
    </div>
  );
}

function NavigationLink({
  item,
  active,
}: {
  item: RouteDefinition;
  active: boolean;
}) {
  return (
    <a
      class={active ? "active" : undefined}
      href={`#${item.path}`}
      aria-current={active ? "page" : undefined}
      aria-label={item.title}
      title={item.title}
    >
      <Icon name={item.icon} size={16} />
    </a>
  );
}

function routeFromHash(): string {
  const path =
    globalThis.location.hash.slice(1).split("?", 1)[0] || "/accounts";
  if (path === "/publications") return "/publish";
  return routes.some((route) => route.path === path) ? path : "/accounts";
}

function formatSidebarSyncTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;

  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;

  const day = date.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear()
      ? {}
      : { year: "numeric" as const }),
  });
  return `${day} ${time}`;
}
