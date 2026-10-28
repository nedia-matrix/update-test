import { SyncRules } from "./sync-rules.js";
import {
  SettingsSection,
  SettingsHeader,
  SettingsReadonlyRow,
  SettingsRow,
  SegmentedControl,
} from "./settings-primitives.js";
import { AccountRuntimeAccess } from "./account-runtime-access.js";
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
      context.setStatus(errorMessage(error, "账号配置更新失败"), "error");
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsSection aria-label="账号配置">
      <SettingsHeader title="账号配置" />
      <SyncRules key={account.id} accountId={account.id} />
      <AccountRuntimeAccess
        key={account.id}
        accountId={account.id}
        disabled={disabled || pending}
      />
      {Object.entries(definitions).map(([key, definition]) => {
        const current = account.settings?.[key] ?? definition.default;
        const currentOption = definition.options.find(
          (option) => option.value === current,
        );
        const currentLabel = currentOption?.label ?? current;
        const description =
          currentOption?.description ?? definition.description;
        if (definition.options.length === 1)
          return (
            <SettingsReadonlyRow
              key={key}
              title={definition.label}
              value={currentLabel}
              description={description}
            />
          );
        return (
          <SettingsRow
            key={key}
            title={definition.label}
            description={description}
          >
            <SegmentedControl
              label={definition.label}
              value={current}
              options={definition.options}
              disabled={disabled || pending}
              onChange={(value) => void change(key, value)}
            />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
