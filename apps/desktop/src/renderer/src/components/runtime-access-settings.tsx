import { SettingsEditor, SegmentedControl } from "./settings-primitives.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { LocalRuntimeSettings } from "../../../bridge/runtime-access.js";
import { Icon } from "./icons.js";
import { SettingsDisclosure } from "./settings-disclosure.js";

type SettingField = "port" | "password" | "origins";
type Feedback = { message: string; failed: boolean };

export function RuntimeAccessSettings() {
  const [settings, setSettings] = useState<LocalRuntimeSettings | null>(null);
  const [port, setPort] = useState("17653");
  const [originMode, setOriginMode] = useState<"any" | "specified">("any");
  const [originRows, setOriginRows] = useState([{ id: 0, value: "" }]);
  const nextOriginId = useRef(1);
  const acceptOrigins = (values: string[]) => {
    setOriginMode(values.includes("*") ? "any" : "specified");
    if (!values.includes("*")) {
      setOriginRows(
        values.map((value) => ({ id: nextOriginId.current++, value })),
      );
    }
  };
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [pending, setPending] = useState<SettingField | null>(null);
  const [feedback, setFeedback] = useState<
    Partial<Record<SettingField, Feedback>>
  >({});
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    window.matrix
      .getLocalRuntimeSettings()
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setPort(String(value.port));
        acceptOrigins(value.allowedOrigins);
      })
      .catch(() => {
        if (active) setLoadError("无法读取本地服务配置");
      });
    return () => {
      active = false;
    };
  }, []);

  const clearFeedback = (field: SettingField) =>
    setFeedback((previous) => ({ ...previous, [field]: undefined }));
  const parsedOrigins =
    originMode === "any" ? ["*"] : originRows.map((row) => row.value.trim());
  const originsComplete =
    originMode === "any" ||
    (originRows.length > 0 && parsedOrigins.every(Boolean));
  const addOrigin = () => {
    const id = nextOriginId.current++;
    setOriginRows((rows) => [...rows, { id, value: "" }]);
    clearFeedback("origins");
    requestAnimationFrame(() =>
      document.getElementById(`runtime-origin-${id}`)?.focus(),
    );
  };
  const portChanged = !!settings && port !== String(settings.port);
  const originsChanged =
    !!settings &&
    JSON.stringify(parsedOrigins) !== JSON.stringify(settings.allowedOrigins);
  const passwordChanged = clearPassword || password.length > 0;
  const save = async (event: Event, field: SettingField) => {
    event.preventDefault();
    if (!settings || pending) return;
    setPending(field);
    setFeedback((previous) => ({ ...previous, [field]: undefined }));
    try {
      // The bridge accepts the complete configuration. Use saved values for
      // other fields so saving one editor never submits another editor's draft.
      const value = await window.matrix.updateLocalRuntimeSettings({
        port: field === "port" ? Number(port) : settings.port,
        allowedOrigins:
          field === "origins" ? parsedOrigins : settings.allowedOrigins,
        ...(field === "password"
          ? { password: clearPassword ? "" : password }
          : {}),
      });
      setSettings(value);
      if (field === "port") setPort(String(value.port));
      if (field === "origins") acceptOrigins(value.allowedOrigins);
      if (field === "password") {
        setPassword("");
        setClearPassword(false);
        setShowPassword(false);
      }
      setFeedback((previous) => ({
        ...previous,
        [field]: { message: "已保存，原有连接需重新连接。", failed: false },
      }));
    } catch (error) {
      setFeedback((previous) => ({
        ...previous,
        [field]: {
          message:
            error instanceof Error
              ? error.message
                  .replace(/^Error invoking remote method '[^']+':\s*/, "")
                  .replace(/^(?:Error|TypeError):\s*/, "")
                  .replace(
                    /^Invalid URL$/,
                    "请填写完整的网站来源，例如 https://example.com",
                  )
              : "保存失败",
          failed: true,
        },
      }));
    } finally {
      setPending(null);
    }
  };
  const renderFeedback = (field: SettingField) => {
    const result = feedback[field];
    return (
      result && (
        <p
          class={`settings-feedback${result.failed ? " settings-feedback-error" : ""}`}
          role={result.failed ? "alert" : "status"}
        >
          {result.message}
        </p>
      )
    );
  };
  const originsSummary = !settings
    ? "正在读取…"
    : settings.allowedOrigins.includes("*")
      ? "任意来源"
      : settings.allowedOrigins.length === 1
        ? settings.allowedOrigins[0]!
        : `已允许 ${settings.allowedOrigins.length} 个来源`;

  return (
    <div>
      {loadError && (
        <p class="runtime-settings-error" role="alert">
          {loadError}
        </p>
      )}
      <SettingsDisclosure
        title="服务端口"
        description="范围 1–65535，保存后更新连接地址"
        descriptionId="runtime-port-hint"
        summary={settings ? String(settings.port) : "正在读取…"}
        dirty={portChanged}
      >
        <form
          class="runtime-access-form"
          onSubmit={(event) => void save(event, "port")}
        >
          <fieldset disabled={!settings || !!pending}>
            <SettingsEditor
              actions={
                <>
                  <button
                    type="submit"
                    class="secondary-button compact-button"
                    disabled={!portChanged}
                  >
                    {pending === "port" ? "正在保存…" : "保存"}
                  </button>
                </>
              }
              feedback={renderFeedback("port")}
            >
              <input
                aria-label="服务端口"
                aria-describedby="runtime-port-hint"
                type="number"
                min="1"
                max="65535"
                required
                value={port}
                onInput={(event) => {
                  setPort(event.currentTarget.value);
                  clearFeedback("port");
                }}
              />
            </SettingsEditor>
          </fieldset>
        </form>
      </SettingsDisclosure>
      <SettingsDisclosure
        title="连接密码"
        description="至少 12 个字符，留空保持原密码"
        descriptionId="runtime-password-hint"
        summary={
          settings
            ? settings.passwordConfigured
              ? "已设置"
              : "未设置"
            : "正在读取…"
        }
        dirty={passwordChanged}
      >
        <form
          class="runtime-access-form"
          onSubmit={(event) => void save(event, "password")}
        >
          <fieldset disabled={!settings || !!pending}>
            <SettingsEditor
              actions={
                <>
                  <button
                    type="submit"
                    class="secondary-button compact-button"
                    disabled={!passwordChanged}
                  >
                    {pending === "password" ? "正在保存…" : "保存"}
                  </button>
                </>
              }
              feedback={renderFeedback("password")}
            >
              <div class="runtime-password-control">
                <input
                  aria-label="连接密码"
                  aria-describedby="runtime-password-hint"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  value={password}
                  disabled={clearPassword}
                  placeholder={
                    settings?.passwordConfigured
                      ? "输入新密码以替换原密码"
                      : "设置连接密码"
                  }
                  onInput={(event) => {
                    setPassword(event.currentTarget.value);
                    clearFeedback("password");
                  }}
                />
                <button
                  type="button"
                  class="icon-button"
                  disabled={clearPassword}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} size={16} />
                </button>
              </div>

              {settings?.passwordConfigured && (
                <label class="runtime-access-check">
                  <input
                    type="checkbox"
                    checked={clearPassword}
                    onChange={(event) =>
                      setClearPassword(event.currentTarget.checked)
                    }
                  />
                  清除连接密码
                </label>
              )}
            </SettingsEditor>
          </fieldset>
        </form>
      </SettingsDisclosure>
      <SettingsDisclosure
        title="允许的网站来源"
        description={
          originMode === "any"
            ? "允许任意网站访问"
            : "填写含协议的域名，可带端口；不含路径，无来源请求将被拒绝"
        }
        descriptionId="runtime-origins-hint"
        summary={originsSummary}
        dirty={originsChanged}
      >
        <form
          class="runtime-access-form"
          onSubmit={(event) => void save(event, "origins")}
        >
          <fieldset disabled={!settings || !!pending}>
            <div class="settings-actions runtime-origin-mode">
              <SegmentedControl
                label="网站来源范围"
                value={originMode}
                options={[
                  { value: "any", label: "任意来源" },
                  { value: "specified", label: "指定域名" },
                ]}
                disabled={!settings || !!pending}
                onChange={(mode) => {
                  setOriginMode(mode);
                  clearFeedback("origins");
                }}
              />
              <button
                class="secondary-button compact-button"
                type="submit"
                disabled={!originsChanged || !originsComplete}
              >
                {pending === "origins" ? "正在保存…" : "保存"}
              </button>
            </div>
            {originMode === "specified" && (
              <div class="runtime-origin-list">
                {originRows.map((row, index) => (
                  <div class="runtime-origin-row" key={row.id}>
                    <input
                      id={`runtime-origin-${row.id}`}
                      type="url"
                      aria-label={`指定域名 ${index + 1}`}
                      aria-describedby="runtime-origins-hint"
                      required
                      spellcheck={false}
                      placeholder="https://example.com"
                      value={row.value}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setOriginRows((rows) =>
                          rows.map((item) =>
                            item.id === row.id ? { ...item, value } : item,
                          ),
                        );
                        clearFeedback("origins");
                      }}
                    />
                    <div class="settings-actions">
                      <button
                        class="icon-button"
                        type="button"
                        aria-label={`删除域名 ${index + 1}`}
                        title="删除域名"
                        disabled={originRows.length <= 1}
                        onClick={() => {
                          setOriginRows((rows) =>
                            rows.filter((item) => item.id !== row.id),
                          );
                          clearFeedback("origins");
                        }}
                      >
                        <Icon name="minus" size={16} />
                      </button>
                      {index === originRows.length - 1 && (
                        <button
                          class="icon-button"
                          type="button"
                          aria-label="添加域名"
                          title="添加域名"
                          disabled={originRows.length >= 100}
                          onClick={addOrigin}
                        >
                          <Icon name="add" size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {renderFeedback("origins")}
          </fieldset>
        </form>
      </SettingsDisclosure>
    </div>
  );
}
