import { SegmentedControl, SettingsRow } from "./settings-primitives.js";
import { useEffect, useState } from "preact/hooks";

export function AccountRuntimeAccess({
  accountId,
  disabled,
}: {
  accountId: string;
  disabled: boolean;
}) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setAllowed(null);
    setError("");
    window.matrix
      .getRuntimeAccountAccess(accountId)
      .then((value) => {
        if (active) setAllowed(value.allowed);
      })
      .catch(() => {
        if (active) setError("无法读取账号对外访问设置");
      });
    return () => {
      active = false;
    };
  }, [accountId]);
  const change = async (next: boolean) => {
    if (allowed === null || pending || disabled || next === allowed) return;
    setPending(true);
    setError("");
    try {
      const value = await window.matrix.setRuntimeAccountAccess({
        accountId,
        allowed: next,
      });
      setAllowed(value.allowed);
    } catch (error) {
      setError(error instanceof Error ? error.message : "设置失败");
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsRow
      title="外部调用"
      description={allowed ? "允许外部服务调用" : "禁止外部服务调用"}
      feedback={
        error && (
          <p role="alert" class="settings-feedback settings-feedback-error">
            {error}
          </p>
        )
      }
    >
      <SegmentedControl
        label="外部调用"
        value={allowed}
        options={[
          { value: true, label: "允许" },
          { value: false, label: "禁止" },
        ]}
        disabled={disabled || pending || allowed === null}
        onChange={(value) => void change(value)}
      />
    </SettingsRow>
  );
}
