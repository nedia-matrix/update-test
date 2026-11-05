import { TaskSettings } from "../components/task-settings.js";
import {
  SettingsSection,
  SettingsHeader,
} from "../components/settings-primitives.js";
import { RuntimeAccessSettings } from "../components/runtime-access-settings.js";
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
        <SystemSettingsAndInformation context={context} />
      </section>

      <section
        id="settings-panel-appearance"
        class="settings-tab-panel"
        role="tabpanel"
        aria-labelledby="settings-tab-appearance"
        hidden={activeTab !== "appearance"}
        tabIndex={0}
      >
        <SettingsSection aria-labelledby="appearance-title">
          <SettingsHeader
            title="主题"
            titleId="appearance-title"
            summary={
              <>
                {themePreference === "system"
                  ? `跟随系统 · 当前为${resolvedTheme === "dark" ? "深色" : "浅色"}`
                  : themePreference === "dark"
                    ? "深色"
                    : "浅色"}
              </>
            }
            actions={
              <div
                class="theme-options"
                role="radiogroup"
                aria-label="应用主题"
              >
                <ThemeOption
                  preference="system"
                  label="跟随系统"
                  icon="system"
                  selected={themePreference === "system"}
                  onSelect={onThemePreferenceChange}
                />
                <ThemeOption
                  preference="light"
                  label="浅色"
                  icon="light"
                  selected={themePreference === "light"}
                  onSelect={onThemePreferenceChange}
                />
                <ThemeOption
                  preference="dark"
                  label="深色"
                  icon="dark"
                  selected={themePreference === "dark"}
                  onSelect={onThemePreferenceChange}
                />
              </div>
            }
          />
        </SettingsSection>
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

function SystemSettingsAndInformation({ context }: { context: AppContext }) {
  return (
    <SettingsSection aria-labelledby="system-settings-title">
      <SettingsHeader title="系统设置与信息" titleId="system-settings-title" />
      <TaskSettings />
      <TechnicalInformation context={context} />
    </SettingsSection>
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
    <SettingsSection aria-labelledby="runtime-title">
      <SettingsHeader
        title="本地服务"
        titleId="runtime-title"
        summary={
          <>
            <span
              class={`runtime-dot runtime-${runtime.status}`}
              aria-hidden="true"
            />
            <span>{statusLabel}</span>
            {endpoint !== "—" && <span>{endpoint}</span>}
          </>
        }
        actions={
          <button
            class={running ? "secondary-button runtime-stop-button" : undefined}
            type="button"
            disabled={loading || actionPending}
            onClick={() => void onRunningChange(!running)}
          >
            {actionPending ? "处理中…" : running ? "关闭服务" : "启动服务"}
          </button>
        }
      />
      <RuntimeAccessSettings />
      {error && (
        <p class="runtime-settings-error" role="alert">
          操作失败：{error}
        </p>
      )}
    </SettingsSection>
  );
}

function ThemeOption({
  preference,
  label,
  icon,
  selected,
  onSelect,
}: {
  preference: ThemePreference;
  label: string;
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
        </span>
        <span class="theme-check" aria-hidden="true">
          {selected && <Icon name="check" size={14} />}
        </span>
      </span>
    </button>
  );
}
