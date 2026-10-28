import type { ComponentChildren } from "preact";
import { Icon } from "./icons.js";

export function SettingsDisclosure({
  title,
  summary,
  description,
  descriptionId,
  dirty = false,
  children,
  class: className,
  onOpenChange,
}: {
  title: string;
  summary?: string;
  description?: string;
  descriptionId?: string;
  dirty?: boolean;
  children: ComponentChildren;
  class?: string;
  onOpenChange?(open: boolean): void;
}) {
  return (
    <details
      class={`settings-disclosure${className ? ` ${className}` : ""}`}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
    >
      <summary>
        <Icon name="chevron-down" size={14} />
        <strong>{title}</strong>
        {description && (
          <span id={descriptionId} class="settings-disclosure-description">
            {description}
          </span>
        )}
        {dirty && <span class="settings-disclosure-dirty">未保存</span>}
        {summary && (
          <span class="settings-disclosure-summary" title={summary}>
            {summary}
          </span>
        )}
      </summary>
      <div class="settings-disclosure-body">{children}</div>
    </details>
  );
}
