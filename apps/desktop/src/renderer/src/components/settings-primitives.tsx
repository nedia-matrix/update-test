import type { ComponentChildren, JSX } from "preact";

/** Shared card shell; business state and operations stay in the caller. */
export function SettingsSection({
  children,
  class: className,
  ...attributes
}: JSX.HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...attributes}
      class={`settings-surface${className ? ` ${className}` : ""}`}
    >
      {children}
    </section>
  );
}

export function SettingsHeader({
  title,
  titleId,
  summary,
  actions,
}: {
  title: string;
  titleId?: string;
  summary?: ComponentChildren;
  actions?: ComponentChildren;
}) {
  return (
    <header
      class={`settings-section-header${summary !== undefined ? " settings-overview-header" : ""}`}
    >
      <div class="settings-header-copy">
        <h2 id={titleId}>{title}</h2>
        {summary !== undefined && (
          <div class="settings-header-info">{summary}</div>
        )}
      </div>
      {actions && <div class="settings-header-actions">{actions}</div>}
    </header>
  );
}

/** A shared expanded-item layout: content left, actions right, feedback below. */
export function SettingsEditor({
  children,
  actions,
  feedback,
  layout = "inline",
}: {
  children?: ComponentChildren;
  actions: ComponentChildren;
  feedback?: ComponentChildren;
  layout?: "inline" | "stacked";
}) {
  return (
    <div
      class={`settings-editor${children ? "" : " settings-editor-action-only"}${layout === "stacked" ? " settings-editor-stacked" : ""}`}
    >
      {children && <div class="settings-editor-content">{children}</div>}
      <div class="settings-actions settings-editor-actions">{actions}</div>
      {feedback && <div class="settings-editor-feedback">{feedback}</div>}
    </div>
  );
}

/** A setting that exposes its control directly, without disclosure behavior. */
export function SettingsRow({
  title,
  description,
  children,
  status,
  feedback,
}: {
  title: string;
  description?: string;
  children: ComponentChildren;
  status?: string;
  feedback?: ComponentChildren;
}) {
  return (
    <div class="settings-row">
      <div class="settings-row-label">
        <strong>{title}</strong>
        {description && <p class="settings-row-description">{description}</p>}
        {status && (
          <span class="settings-feedback" role="status">
            {status}
          </span>
        )}
      </div>
      <div class="settings-row-control">{children}</div>
      {feedback && <div class="settings-row-feedback">{feedback}</div>}
    </div>
  );
}

export function SettingsReadonlyRow({
  title,
  value,
  description,
  feedback,
}: {
  title: string;
  value: string;
  description?: string;
  feedback?: ComponentChildren;
}) {
  return (
    <SettingsRow title={title} description={description} feedback={feedback}>
      <span class="settings-row-value">{value}</span>
    </SettingsRow>
  );
}

export function SegmentedControl<T extends string | boolean>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T | null | undefined;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange(value: T): void;
}) {
  return (
    <div
      class="segmented-control settings-segmented-control"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          class={value === option.value ? "active" : undefined}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => {
            if (!disabled && value !== option.value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
