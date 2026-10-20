import { PlatformPluginSettings } from "../components/platform-plugin-settings.js";
import { TechnicalInformation } from "../components/technical-information.js";
import { BrowserSettings } from "../components/browser-settings.js";
import type { AppContext } from "../app-context.js";
import { Icon } from "../components/icons.js";
import { ApplicationUpdateSettings } from "../components/application-update-settings.js";
import type { ResolvedTheme, ThemePreference } from "../theme.js";
import { useEffect, useState } from "preact/hooks";
import { isBrowserSettingsLocation } from "../browser-settings-navigation.js";

const settingsTabs = [
  { id: "application", label: "应用" },
  { id: "appearance", label: "外观" },
  { id: "platform", label: "平台" },
] as const;

type SettingsTab = (typeof settingsTabs)[number]["id"];

export interface RuntimeSummary {
  version: string | null;
  status: "loading" | "running" | "stopped" | "unknown";
  host: "127.0.0.1" | null;
  port: number | null;
}

export function SettingsPage({
  context,
  themePreference = "system",
  resolvedTheme = "light",
  onThemePreferenceChange = () => undefined,
  runtime = { version: null, status: "loading", host: null, port: null },
  runtimeActionPending = false,
  runtimeError = null,
  onRuntimeRunningChange = () => undefined,
}: {
  context: AppContext;
  themePreference?: ThemePreference;
  resolvedTheme?: ResolvedTheme;
  onThemePreferenceChange?: (preference: ThemePreference) => void;
  runtime?: RuntimeSummary;
  runtimeActionPending?: boolean;
  runtimeError?: string | null;
  onRuntimeRunningChange?: (running: boolean) => void | Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() =>
    isBrowserSettingsLocation(globalThis.location.hash)
      ? "platform"
      : "application",
  );
  useEffect(() => {
    let frame: number | undefined;
    const navigate = () => {
      if (!isBrowserSettingsLocation(globalThis.location.hash)) return;
      setActiveTab("platform");
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const section = document.getElementById("browser-settings");
        section?.scrollIntoView({ block: "start" });
        section?.focus({ preventScroll: true });
      });
    };
    navigate();
    globalThis.addEventListener("hashchange", navigate);
    return () => {
      globalThis.removeEventListener("hashchange", navigate);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div class="settings-layout">
      <header class="workspace-header settings-page-header">
        <span class="workspace-header-icon" aria-hidden="true">
          <Icon name="settings" size={24} />
        </span>
        <div class="workspace-header-copy">
          <h1>设置</h1>
          <p>管理应用、外观与平台设置。</p>
        </div>
      </header>

      <nav
        class="workspace-tabs settings-tabs"
        role="tablist"
        aria-label="设置分类"
      >
        {settingsTabs.map(({ id, label }, index) => (
          <button
            key={id}
            id={`settings-tab-${id}`}
            class={activeTab === id ? "active" : undefined}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`settings-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => setActiveTab(id)}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? settingsTabs.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % settingsTabs.length
                      : event.key === "ArrowLeft"
                        ? (index + settingsTabs.length - 1) %
                          settingsTabs.length
                        : undefined;
              if (nextIndex === undefined) return;
              event.preventDefault();
              const next = settingsTabs[nextIndex]!;
              setActiveTab(next.id);
              document.getElementById(`settings-tab-${next.id}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <section
        id="settings-panel-application"
        class="settings-tab-panel"
        role="tabpanel"
        aria-labelledby="settings-tab-application"
        hidden={activeTab !== "application"}
        tabIndex={0}
      >
        <ApplicationUpdateSettings />
        <RuntimeSettings
          runtime={runtime}
          actionPending={runtimeActionPending}
          error={runtimeError}
          onRunningChange={onRuntimeRunningChange}
        />
        <AutomationDiagnosticSettings context={context} />
      </section>

      <section
        id="settings-panel-appearance"
        class="settings-tab-panel"
        role="tabpanel"
        aria-labelledby="settings-tab-appearance"
        hidden={activeTab !== "appearance"}
        tabIndex={0}
      >
        <section class="settings-surface" aria-labelledby="appearance-title">
          <header class="settings-section-header">
            <div>
              <h2 id="appearance-title">主题</h2>
              <p>选择 Nedia Matrix 在这台设备上的显示方式。</p>
            </div>
          </header>
          <div class="theme-options" role="radiogroup" aria-label="应用主题">
            <ThemeOption
              preference="system"
              label="跟随系统"
              detail={`当前使用${resolvedTheme === "dark" ? "深色" : "浅色"}外观`}
              icon="system"
              selected={themePreference === "system"}
              onSelect={onThemePreferenceChange}
            />
            <ThemeOption
              preference="light"
              label="浅色"
              detail="始终使用浅色外观"
              icon="light"
              selected={themePreference === "light"}
              onSelect={onThemePreferenceChange}
            />
            <ThemeOption
              preference="dark"
              label="深色"
              detail="始终使用深色外观"
              icon="dark"
              selected={themePreference === "dark"}
              onSelect={onThemePreferenceChange}
            />
          </div>
        </section>
      </section>

      <section
        id="settings-panel-platform"
        class="settings-tab-panel"
        role="tabpanel"
        aria-labelledby="settings-tab-platform"
        hidden={activeTab !== "platform"}
        tabIndex={0}
      >
        <BrowserSettings />
        <PlatformPluginSettings />
      </section>
    </div>
  );
}

function AutomationDiagnosticSettings({ context }: { context: AppContext }) {
  const [opening, setOpening] = useState(false);

  return (
    <section class="settings-surface" aria-labelledby="diagnostics-title">
      <header class="settings-section-header">
        <div>
          <h2 id="diagnostics-title">本地诊断</h2>
          <p>记录应用启动、账号、发布、同步及关键基础设施的诊断过程。</p>
        </div>
      </header>
      <div class="runtime-settings-row">
        <div class="runtime-settings-status">
          <span>
            <strong>本地诊断日志</strong>
            <small>JSONL · 保留 14 天 · 日志与截图最多 100 MiB</small>
          </span>
        </div>
        <button
          class="secondary-button"
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
      </div>
      <TechnicalInformation context={context} />
    </section>
  );
}

function RuntimeSettings({
  runtime,
  actionPending,
  error,
  onRunningChange,
}: {
  runtime: RuntimeSummary;
  actionPending: boolean;
  error: string | null;
  onRunningChange(running: boolean): void | Promise<void>;
}) {
  const running = runtime.status === "running";
  const loading = runtime.status === "loading";
  const statusLabel =
    runtime.status === "loading"
      ? "正在读取状态"
      : running
        ? "运行中"
        : runtime.status === "stopped"
          ? "已停止"
          : "状态未知";
  const endpoint =
    runtime.host && runtime.port ? `${runtime.host}:${runtime.port}` : "—";

  return (
    <section class="settings-surface" aria-labelledby="runtime-title">
      <header class="settings-section-header">
        <div>
          <h2 id="runtime-title">本地服务</h2>
          <p>允许 Web 端连接桌面应用并使用本机账号与发布能力。</p>
        </div>
      </header>
      <div class="runtime-settings-row">
        <div class="runtime-settings-status">
          <span
            class={`runtime-dot runtime-${runtime.status}`}
            aria-hidden="true"
          />
          <span>
            <strong>{statusLabel}</strong>
            <small>{endpoint}</small>
          </span>
        </div>
        <button
          class={running ? "secondary-button runtime-stop-button" : undefined}
          type="button"
          disabled={loading || actionPending}
          onClick={() => void onRunningChange(!running)}
        >
          {actionPending ? "处理中…" : running ? "关闭服务" : "启动服务"}
        </button>
      </div>
      {error && (
        <p class="runtime-settings-error" role="alert">
          操作失败：{error}
        </p>
      )}
    </section>
  );
}

function ThemeOption({
  preference,
  label,
  detail,
  icon,
  selected,
  onSelect,
}: {
  preference: ThemePreference;
  label: string;
  detail: string;
  icon: "system" | "light" | "dark";
  selected: boolean;
  onSelect(preference: ThemePreference): void;
}) {
  return (
    <button
      class={`theme-option${selected ? " selected" : ""}`}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(preference)}
    >
      <span class="theme-option-copy">
        <Icon name={icon} size={17} />
        <span>
          <strong>{label}</strong>
          <small>{detail}</small>
        </span>
        <span class="theme-check" aria-hidden="true">
          {selected && <Icon name="check" size={14} />}
        </span>
      </span>
    </button>
  );
}
