import { useState } from "preact/hooks";

import type { AppStatus } from "../app-context.js";
import { Icon } from "./icons.js";

export function GlobalStatus({
  status,
  onDismiss,
}: {
  status: AppStatus;
  onDismiss: () => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<{
    status: AppStatus;
    result: "success" | "error";
  } | null>(null);
  const copyResult =
    copyFeedback?.status === status ? copyFeedback.result : null;
  const copyLabel =
    copyResult === "success"
      ? "已复制"
      : copyResult === "error"
        ? "复制失败，请选中文字复制"
        : "复制完整消息";

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(status.message);
      setCopyFeedback({ status, result: "success" });
    } catch {
      setCopyFeedback({ status, result: "error" });
    }
  };

  return (
    <div class={`global-status status-${status.kind}`}>
      <span class="status-indicator" aria-hidden="true" />
      <output
        class="global-status-message"
        role={status.kind === "error" ? "alert" : "status"}
        aria-live={status.kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
        tabIndex={0}
        title={status.message}
      >
        {status.message}
      </output>
      {status.kind === "error" && (
        <div class="global-status-actions">
          <button
            class="icon-button"
            type="button"
            onClick={() => void copyMessage()}
            aria-label={copyLabel}
            title={copyLabel}
          >
            <Icon
              name={copyResult === "success" ? "check" : "copy"}
              size={14}
            />
          </button>
          <button
            class="icon-button"
            type="button"
            aria-label="关闭消息提示"
            title="关闭消息提示"
            onClick={onDismiss}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
