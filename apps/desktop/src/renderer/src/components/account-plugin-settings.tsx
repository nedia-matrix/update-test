import { useEffect, useState } from "preact/hooks";
import type { PlatformAccountView } from "@nedia-matrix/account-management";
import type { AppContext } from "../app-context.js";
import { errorMessage, platformFor } from "../shared.js";

export function AccountPluginSettings({
  account,
  context,
  disabled,
  onBusy,
  onUpdated,
}: {
  account: PlatformAccountView;
  context: AppContext;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onUpdated(accountId: string): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    onBusy(pending);
    return () => onBusy(false);
  }, [pending]);
  const platform = platformFor(context.platforms, account.platformId);
  const definitions = platform?.settings ?? {};
  if (!Object.keys(definitions).length) return null;
  const change = async (key: string, value: string) => {
    setPending(true);
    try {
      await window.matrix.setAccountSettings({
        accountId: account.id,
        settings: { [key]: value },
      });
      await onUpdated(account.id);
      context.setStatus("账号设置已更新");
    } catch (error) {
      context.setStatus(errorMessage(error, "平台设置更新失败"), "error");
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      class="settings-surface account-plugin-settings"
      aria-label="账号平台设置"
    >
      <header class="settings-section-header">
        <div>
          <h2>平台设置</h2>
        </div>
      </header>
      {Object.entries(definitions).map(([key, definition]) => {
        const current = account.settings?.[key] ?? definition.default;
        return (
          <div class="account-settings-row" key={key}>
            <div class="account-settings-copy">
              <strong>{definition.label}</strong>
            </div>
            {definition.options.length === 1 ? (
              <span class="account-settings-value">
                {definition.options[0]!.label}
              </span>
            ) : (
              <div
                class="segmented-control"
                role="group"
                aria-label={definition.label}
              >
                {definition.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    class={current === option.value ? "active" : undefined}
                    aria-pressed={current === option.value}
                    disabled={disabled || pending}
                    onClick={() => {
                      if (current !== option.value)
                        void change(key, option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
