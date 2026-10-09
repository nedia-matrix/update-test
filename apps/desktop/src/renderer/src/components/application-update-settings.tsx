import { useEffect, useState } from "preact/hooks";
import type { ApplicationUpdateState } from "../../../bridge/contracts.js";
import { errorMessage } from "../shared.js";
import { DEFAULT_UPDATE_SOURCE_URL } from "../../../bridge/update-source.js";

export function ApplicationUpdateSettings() {
  const [state, setState] = useState<ApplicationUpdateState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_UPDATE_SOURCE_URL);
  const [savedSourceUrl, setSavedSourceUrl] = useState(
    DEFAULT_UPDATE_SOURCE_URL,
  );
  const [sourceLoaded, setSourceLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    const accept = (next: ApplicationUpdateState) => {
      if (mounted)
        setState((previous) =>
          !previous || next.revision >= previous.revision ? next : previous,
        );
    };
    const unsubscribe = window.matrix.onApplicationUpdateChanged(accept);
    void window.matrix
      .getPreferences()
      .then((preferences) => {
        if (mounted) {
          setSourceUrl(
            preferences.updates.sourceUrl ?? DEFAULT_UPDATE_SOURCE_URL,
          );
          setSavedSourceUrl(
            preferences.updates.sourceUrl ?? DEFAULT_UPDATE_SOURCE_URL,
          );
          setSourceLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (mounted)
          setActionError(
            errorMessage(error, "读取更新地址失败，请检查偏好文件"),
          );
      });
    void window.matrix
      .getApplicationUpdateState()
      .then(accept)
      .catch((error: unknown) => {
        if (mounted) setActionError(errorMessage(error, "读取更新状态失败"));
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const run = async (operation: () => Promise<unknown>) => {
    setActionPending(true);
    setActionError(null);
    try {
      await operation();
    } catch (error) {
      setActionError(errorMessage(error, "更新操作失败"));
    } finally {
      setActionPending(false);
    }
  };
  const busy =
    state?.phase === "checking" ||
    state?.phase === "downloading" ||
    state?.phase === "verifying";
  const sourceChanged = sourceUrl.trim() !== savedSourceUrl;
  const sourceCanReset =
    sourceUrl.trim() !== DEFAULT_UPDATE_SOURCE_URL ||
    savedSourceUrl !== DEFAULT_UPDATE_SOURCE_URL;
  const feedback =
    actionError ??
    state?.error?.message ??
    (state?.phase === "up-to-date" ? "已是最新" : state?.message);
  const openPage = () =>
    window.matrix.openApplicationUpdateDownload({
      version: state!.latestVersion!,
    });

  return (
    <section class="settings-surface" aria-labelledby="software-update-title">
      <header class="settings-section-header">
        <div>
          <h2 id="software-update-title">软件更新</h2>
          <p>检查新版本并管理软件更新地址。</p>
        </div>
      </header>
      <div class="update-settings-body">
        <div class="update-settings-overview">
          <div class="update-settings-summary">
            <div class="update-version">
              <strong>当前版本</strong>
              <small>{state ? `v${state.currentVersion}` : "正在读取…"}</small>
              {state?.latestVersion && (
                <span class="update-latest-version">
                  新版本 v{state.latestVersion}
                </span>
              )}
            </div>
            {(feedback ||
              state?.phase === "downloading" ||
              state?.phase === "verifying") && (
              <div class="update-settings-feedback">
                {feedback && (
                  <p
                    class={`update-check-feedback${state?.error || actionError ? " update-check-error" : ""}`}
                    role={state?.error || actionError ? "alert" : "status"}
                  >
                    {feedback}
                  </p>
                )}
                {(state?.phase === "downloading" ||
                  state?.phase === "verifying") && (
                  <div class="update-download-progress" role="status">
                    <progress
                      max={state.totalBytes || 1}
                      value={state.receivedBytes}
                      aria-label="更新包下载进度"
                    />
                    <span>
                      {state.phase === "verifying"
                        ? "正在校验…"
                        : `${Math.floor((state.receivedBytes / Math.max(1, state.totalBytes)) * 100)}% · ${(state.receivedBytes / 1048576).toFixed(1)} / ${(state.totalBytes / 1048576).toFixed(1)} MiB`}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          <div class="update-settings-actions">
            <button
              class="secondary-button compact-button"
              type="button"
              disabled={
                !state || busy || actionPending || state.phase === "ready"
              }
              onClick={() =>
                void run(() => window.matrix.checkForApplicationUpdate())
              }
            >
              {state?.phase === "checking"
                ? "正在检查…"
                : state?.phase === "idle"
                  ? "检查新版本"
                  : "重新检查"}
            </button>
            {state?.latestVersion && !busy && state.phase !== "ready" && (
              <button
                class="compact-button"
                type="button"
                disabled={actionPending}
                onClick={() =>
                  void run(
                    state.downloadAvailable
                      ? () => window.matrix.downloadApplicationUpdate()
                      : openPage,
                  )
                }
              >
                {state.downloadAvailable && state.error?.stage === "download"
                  ? "重新下载"
                  : `下载 v${state.latestVersion}`}
              </button>
            )}
            {state?.phase === "downloading" && (
              <button
                class="secondary-button compact-button"
                type="button"
                onClick={() =>
                  void window.matrix
                    .cancelApplicationUpdateDownload()
                    .catch((error: unknown) =>
                      setActionError(errorMessage(error, "取消下载失败")),
                    )
                }
              >
                取消下载
              </button>
            )}
            {state?.phase === "ready" && (
              <button
                class="compact-button"
                type="button"
                disabled={actionPending}
                onClick={() =>
                  void run(() => window.matrix.showApplicationUpdateFile())
                }
              >
                打开文件位置
              </button>
            )}
            {state?.latestVersion && state.downloadAvailable && (
              <button
                class="secondary-button compact-button"
                type="button"
                onClick={() => void run(openPage)}
              >
                打开下载页
              </button>
            )}
          </div>
        </div>
        <div class="update-source-settings">
          <div class="update-source-copy">
            <label class="update-source-label" for="update-source-url">
              更新地址
            </label>
            <p id="update-source-hint">
              支持 GitHub 仓库或更新清单地址，仅接受已签名的正式更新。
            </p>
          </div>
          <div class="update-source-controls">
            <input
              id="update-source-url"
              class="update-source-input"
              type="url"
              aria-describedby="update-source-hint"
              spellcheck={false}
              value={sourceUrl}
              disabled={!sourceLoaded || busy || actionPending}
              onInput={(event) => setSourceUrl(event.currentTarget.value)}
              placeholder={DEFAULT_UPDATE_SOURCE_URL}
            />
            <div class="update-settings-actions">
              <button
                type="button"
                class="secondary-button compact-button"
                disabled={
                  !sourceLoaded ||
                  !state ||
                  busy ||
                  actionPending ||
                  !sourceChanged
                }
                onClick={() =>
                  void run(async () => {
                    const preferences = await window.matrix.updatePreferences({
                      updates: { sourceUrl },
                    });
                    const nextSourceUrl =
                      preferences.updates.sourceUrl ??
                      DEFAULT_UPDATE_SOURCE_URL;
                    setSourceUrl(nextSourceUrl);
                    setSavedSourceUrl(nextSourceUrl);
                  })
                }
              >
                保存
              </button>
              <button
                type="button"
                class="secondary-button compact-button"
                disabled={
                  !sourceLoaded ||
                  !state ||
                  busy ||
                  actionPending ||
                  !sourceCanReset
                }
                onClick={() =>
                  void run(async () => {
                    const preferences = await window.matrix.updatePreferences({
                      updates: { sourceUrl: null },
                    });
                    const nextSourceUrl =
                      preferences.updates.sourceUrl ??
                      DEFAULT_UPDATE_SOURCE_URL;
                    setSourceUrl(nextSourceUrl);
                    setSavedSourceUrl(nextSourceUrl);
                  })
                }
              >
                恢复默认
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
