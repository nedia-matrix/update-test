import type { AccountBrowserRuntime } from "../../../bridge/account-browser-runtime.js";
import { Icon } from "./icons.js";

export type BrowserRuntimeStatus =
  AccountBrowserRuntime["mode"] | "stopped" | "unknown";

export function AccountBrowserStatus({
  status,
  compact = false,
  runningOnly = false,
}: {
  status: BrowserRuntimeStatus;
  compact?: boolean;
  runningOnly?: boolean;
}) {
  const running = status === "window" || status === "background";
  if (runningOnly && !running) return null;
  const label = browserRuntimeLabel(status);
  return (
    <span
      class={`account-browser-status${running ? " running" : ""}`}
      title={label}
      aria-label={label}
    >
      <Icon name="browser" size={16} />
      {!compact && <span>{label}</span>}
    </span>
  );
}

export function browserRuntimeLabel(status: BrowserRuntimeStatus): string {
  return status === "unknown"
    ? "浏览器状态未知"
    : status === "stopped"
      ? "浏览器未运行"
      : status === "background"
        ? "浏览器后台运行中"
        : "浏览器运行中";
}
