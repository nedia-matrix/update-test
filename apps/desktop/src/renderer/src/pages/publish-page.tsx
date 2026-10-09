import type { PublishResultUpdate } from "@nedia-matrix/publishing";
import type { PublicationTaskSummary } from "@nedia-matrix/publishing";
import type {
  SubmissionMode,
  SupportedPublishContentForm as PublishContentForm,
} from "@nedia-matrix/publishing";
import { preparePublishText } from "@nedia-matrix/platform-sdk";
import type { PlatformSummary } from "../../../bridge/contracts.js";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";

import type { AppContext } from "../app-context.js";
import { Icon } from "../components/icons.js";
import { PlatformIcon } from "../components/platform-icon.js";
import { publicationRecordsHref } from "../publishing-route.js";
import {
  accountLabel,
  errorMessage,
  publicationStateLabels,
} from "../shared.js";

interface MediaSelection {
  id: string;
  accountId: string;
  contentForm: PublishContentForm;
  files: readonly { name: string; size: number }[];
}

export function PublishPage({
  context,
  preferredAccountId,
  active,
  headerActionsTarget,
}: {
  context: AppContext;
  preferredAccountId?: string;
  active: boolean;
  headerActionsTarget: HTMLDivElement | null;
}) {
  const [accounts, setAccounts] = useState(context.accounts);
  const [accountId, setAccountId] = useState(
    context.recreatedDraft
      ? context.recreatedDraft.accountId
      : context.accounts.some(({ id }) => id === preferredAccountId)
        ? (preferredAccountId ?? "")
        : (context.accounts[0]?.id ?? ""),
  );
  const [contentForm, setContentForm] = useState<PublishContentForm>(
    () => context.recreatedDraft?.contentForm ?? "imageText",
  );
  const [submissionMode, setSubmissionMode] = useState<SubmissionMode>(
    "manual_confirmation",
  );
  const [title, setTitle] = useState(() => context.recreatedDraft?.title ?? "");
  const [body, setBody] = useState(() => context.recreatedDraft?.body ?? "");
  const [tags, setTags] = useState(
    () => context.recreatedDraft?.tags.join("，") ?? "",
  );
  const [mediaSelection, setMediaSelection] = useState<
    MediaSelection | undefined
  >(() => {
    const draft = context.recreatedDraft;
    return draft?.mediaSelectionId
      ? {
          id: draft.mediaSelectionId,
          accountId: draft.accountId,
          contentForm: draft.contentForm,
          files: draft.reusableAssets,
        }
      : undefined;
  });
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const [activeObservationId, setActiveObservationId] = useState<string>();
  const [currentTask, setCurrentTask] = useState<PublicationTaskSummary | null>(
    null,
  );
  useEffect(() => {
    const id = context.activePublicationId;
    if (!id) return;
    let active = true;
    const refresh = () => {
      void window.matrix
        .getPublicationTask({ publicationId: id })
        .then((task) => {
          if (active) setCurrentTask(task);
        })
        .catch(() => undefined);
    };
    refresh();
    const stop = context.onPublishUpdate((update) => {
      if (update.publicationId === id) refresh();
    });
    return () => {
      active = false;
      stop();
    };
  }, [context, context.activePublicationId, submissionInFlight]);

  const selectedAccount = accounts.find(({ id }) => id === accountId);
  const platform = context.platforms.find(
    ({ id }) => id === selectedAccount?.platformId,
  );
  const capability = platform?.publishCapabilities.find(
    ({ contentForm: supportedForm }) => supportedForm === contentForm,
  );
  const supportedForms = useMemo(
    () =>
      new Set(
        platform?.publishCapabilities.map(({ contentForm }) => contentForm),
      ),
    [platform],
  );
  const requestedTags = useMemo(() => parseTags(tags), [tags]);
  const preparedBody = capability
    ? preparePublishText(
        {
          tagPolicy: capability.tagPolicy
            ? { ...capability.tagPolicy, maxCount: undefined }
            : undefined,
        },
        body.trim(),
        requestedTags,
      ).body
    : body.trim();
  const titleFeedback = textConstraintFeedback(
    capability,
    "title",
    title.trim(),
  );
  const bodyFeedback = textConstraintFeedback(capability, "body", preparedBody);
  const tagLimitExceeded =
    capability?.tagPolicy?.maxCount !== undefined &&
    requestedTags.length > capability.tagPolicy.maxCount;
  const mediaLimitExceeded =
    mediaSelection !== undefined &&
    capability?.constraints.mediaMaxCount !== undefined &&
    mediaSelection.files.length > capability.constraints.mediaMaxCount;
  const hasHardConstraintViolation =
    titleFeedback.exceeded ||
    bodyFeedback.exceeded ||
    tagLimitExceeded ||
    mediaLimitExceeded;

  useEffect(() => {
    let active = true;
    void context
      .refreshAccounts()
      .then((refreshed) => {
        if (!active) return;
        setAccounts(refreshed);
        setAccountId((current) =>
          refreshed.some(({ id }) => id === current)
            ? current
            : (refreshed.find(({ id }) => id === preferredAccountId)?.id ??
              refreshed[0]?.id ??
              ""),
        );
      })
      .catch((error) =>
        context.setStatus(errorMessage(error, "账号加载失败"), "error"),
      );
    const stopUpdates = context.onAccountUpdate((refreshed) => {
      if (!active) return;
      setAccounts(refreshed);
      setAccountId((current) =>
        refreshed.some(({ id }) => id === current)
          ? current
          : (refreshed[0]?.id ?? ""),
      );
    });
    return () => {
      active = false;
      stopUpdates();
    };
  }, [context, preferredAccountId]);

  useEffect(() => {
    if (supportedForms.has(contentForm)) return;
    const firstSupported = platform?.publishCapabilities[0]?.contentForm;
    if (firstSupported) setContentForm(firstSupported);
  }, [contentForm, platform, supportedForms]);

  useEffect(() => {
    if (!capability) return;
    const supportedModes = capability.submissionModes;
    if (!supportedModes.includes(submissionMode)) {
      setSubmissionMode(supportedModes[0] ?? "automatic");
    }
  }, [capability, submissionMode]);

  const previousMediaTarget = useRef({ accountId, contentForm });
  useEffect(() => {
    if (
      previousMediaTarget.current.accountId === accountId &&
      previousMediaTarget.current.contentForm === contentForm
    )
      return;
    previousMediaTarget.current = { accountId, contentForm };
    setMediaSelection(undefined);
  }, [accountId, contentForm]);

  useEffect(
    () =>
      context.onPublishUpdate((update) => {
        if (update.observationId === activeObservationId) {
          renderPublishResult(context, update);
        }
      }),
    [activeObservationId, context],
  );

  const selectMedia = async () => {
    if (!accountId) {
      context.setStatus("请先连接并选择平台账号", "error");
      return;
    }
    context.setStatus("正在选择本地媒体…", "busy");
    try {
      const result = await window.matrix.selectPublishMedia({
        accountId,
        contentForm,
      });
      if (result.status === "cancelled") {
        context.setStatus("已取消选择媒体");
        return;
      }
      setMediaSelection({
        id: result.selectionId,
        accountId,
        contentForm,
        files: result.files,
      });
      context.setStatus(`已选择 ${result.files.length} 个媒体文件`);
    } catch (error) {
      context.setStatus(errorMessage(error, "选择媒体失败"), "error");
    }
  };

  const submitDraft = async (event: SubmitEvent) => {
    event.preventDefault();
    if (submissionInFlight) return;
    if (!accountId) {
      context.setStatus("请先连接并选择平台账号", "error");
      return;
    }
    if (
      !mediaSelection ||
      mediaSelection.accountId !== accountId ||
      mediaSelection.contentForm !== contentForm
    ) {
      context.setStatus("请为当前账号和内容类型选择媒体", "error");
      return;
    }

    setSubmissionInFlight(true);
    setActiveObservationId(undefined);
    context.setStatus(
      "正在打开发布页并填充草稿，媒体处理可能需要数分钟…",
      "busy",
    );
    try {
      const result = await window.matrix.preparePublishDraft({
        accountId,
        ...(context.recreatedDraft
          ? { sourcePublicationId: context.recreatedDraft.sourcePublicationId }
          : {}),
        contentForm,
        mediaSelectionId: mediaSelection.id,
        title,
        body,
        tags: requestedTags,
        submissionMode,
      });
      if (result.status === "ready_for_review") {
        context.setRecreatedDraft(null);
        context.setActivePublicationId(result.publicationId);
        setMediaSelection(undefined);
        setActiveObservationId(result.publishObservationId ?? undefined);
        const pending = result.publishObservationId
          ? context.recentPublishUpdate(result.publishObservationId)
          : undefined;
        if (pending) renderPublishResult(context, pending);
        else context.setStatus("草稿已填充，请检查后在平台页面手动发布");
        globalThis.location.hash = publicationRecordsHref(
          undefined,
          result.publicationId,
        );
      } else if (result.status === "submission_started") {
        context.setRecreatedDraft(null);
        context.setActivePublicationId(result.publicationId);
        setMediaSelection(undefined);
        setActiveObservationId(result.publishObservationId);
        const pending = context.recentPublishUpdate(
          result.publishObservationId,
        );
        if (pending) renderPublishResult(context, pending);
        else context.setStatus("内容已提交，正在确认平台发布结果…", "busy");
        globalThis.location.hash = publicationRecordsHref(
          undefined,
          result.publicationId,
        );
      } else if (result.status === "already_started") {
        context.setActivePublicationId(result.publicationId);
        context.setStatus(
          `该请求已存在，当前状态：${publicationStateLabels[result.state]}`,
        );
        globalThis.location.hash = publicationRecordsHref(
          undefined,
          result.publicationId,
        );
      } else if (result.status === "login_required") {
        context.setStatus("该账号尚未登录，请先完成登录", "error");
      } else if (result.status === "account_busy") {
        context.setStatus("该账号正在发布其他内容，请等待完成", "error");
      } else if (result.status === "account_unknown") {
        context.setStatus(result.reason, "error");
      } else if (result.status === "uncertain") {
        context.setActivePublicationId(result.publicationId);
        setMediaSelection(undefined);
        const evidence = result.evidenceId ? `，证据 ${result.evidenceId}` : "";
        context.setStatus(
          `${result.code}: ${result.message}${evidence}。请先核实平台结果，不要直接重试`,
          "error",
        );
      } else {
        if (result.publicationId)
          context.setActivePublicationId(result.publicationId);
        if (result.code === "MEDIA_SELECTION_UNAVAILABLE") {
          setMediaSelection(undefined);
        }
        const evidence = result.evidenceId ? `，证据 ${result.evidenceId}` : "";
        context.setStatus(
          `${result.code}: ${result.message}${evidence}`,
          "error",
        );
      }
    } catch (error) {
      context.setStatus(errorMessage(error, "填充草稿失败"), "error");
    } finally {
      setSubmissionInFlight(false);
      await context.refreshPublications();
    }
  };

  if (accounts.length === 0) {
    return (
      <section class="empty-workspace">
        <span class="empty-workspace-icon">
          <Icon name="accounts" size={24} />
        </span>
        <h2>先连接一个平台账号</h2>
        <p>发布内容前，需要一个已登录的平台账号和独立 Session。</p>
        <a class="button-link" href="#/accounts">
          前往账号管理
        </a>
      </section>
    );
  }

  const mediaCount = mediaSelection?.files.length ?? 0;
  const mediaLimit = capability?.constraints.mediaMaxCount;
  const accountName = selectedAccount?.nickname ?? selectedAccount?.displayName;
  const actionHint = hasHardConstraintViolation
    ? "请调整超出平台限制的内容或素材"
    : !capability
      ? "当前账号暂不支持此内容类型"
      : !mediaCount
        ? `请先选择${contentForm === "video" ? "视频" : "图片"}素材`
        : submissionMode === "manual_confirmation"
          ? "填充草稿后，在平台页面检查并手动发布"
          : "填充草稿后，将直接提交到平台";

  return (
    <form
      class="publish-workspace"
      onSubmit={(event) => void submitDraft(event)}
      aria-busy={submissionInFlight}
    >
      {active &&
        headerActionsTarget &&
        createPortal(
          <label class="publish-account-field" for="publish-account">
            <span class="publish-sr-only">发布账号</span>
            <PlatformIcon
              platformId={selectedAccount?.platformId ?? ""}
              platformName={platform?.displayName ?? "平台"}
            />
            <select
              id="publish-account"
              value={accountId}
              disabled={submissionInFlight || Boolean(context.recreatedDraft)}
              onChange={(event) => setAccountId(event.currentTarget.value)}
            >
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {accountLabel(account, context.platforms)}
                </option>
              ))}
            </select>
          </label>,
          headerActionsTarget,
        )}
      {context.activePublicationId && (
        <section class="active-publication-card" aria-label="当前发布记录">
          <div>
            <strong>
              {currentTask
                ? `当前发布记录：${publicationStateLabels[currentTask.state]}`
                : "当前发布记录已保存"}
            </strong>
            <small>可在发布记录中继续查看状态和处理结果。</small>
          </div>
          <a
            class="button-link secondary-button"
            href={publicationRecordsHref(
              undefined,
              context.activePublicationId,
            )}
          >
            查看记录详情
          </a>
        </section>
      )}
      {context.recreatedDraft &&
        !mediaSelection &&
        context.recreatedDraft.unavailableAssets.length > 0 && (
          <section
            class="active-publication-card archive-assets-warning"
            role="status"
          >
            <div>
              <strong>原任务素材不可用</strong>
              <small>
                {context.recreatedDraft.unavailableAssets.join("、")}
                。请重新选择素材后再开始。
              </small>
            </div>
          </section>
        )}

      <fieldset class="publish-draft-fields" disabled={submissionInFlight}>
        <legend class="publish-sr-only">发布内容与设置</legend>

        <div class="publish-layout">
          <div class="publish-content-column">
            <section
              class="editor-surface publish-media-surface"
              aria-labelledby="publish-media-title"
            >
              <header class="surface-header">
                <div class="publish-section-heading">
                  <span class="publish-section-number" aria-hidden="true">
                    01
                  </span>
                  <div>
                    <h2 id="publish-media-title">上传素材</h2>
                    <p>
                      {contentForm === "video"
                        ? "为这次发布选择视频"
                        : "为这次发布选择图片"}
                    </p>
                  </div>
                </div>
                <div class="publish-media-header-actions">
                  <div
                    class="segmented-control"
                    role="group"
                    aria-label="内容类型"
                  >
                    {(["imageText", "video"] as const).map((form) => (
                      <button
                        key={form}
                        class={contentForm === form ? "active" : undefined}
                        type="button"
                        aria-pressed={contentForm === form}
                        disabled={
                          Boolean(context.recreatedDraft) ||
                          !supportedForms.has(form)
                        }
                        onClick={() => setContentForm(form)}
                      >
                        <Icon
                          name={form === "video" ? "video" : "image"}
                          size={16}
                        />
                        {form === "video" ? "视频" : "图文"}
                      </button>
                    ))}
                  </div>
                  <span
                    class={`publish-section-meta${mediaLimitExceeded ? " publish-error" : ""}`}
                  >
                    {mediaCount} {mediaLimit ? `/ ${mediaLimit} ` : ""}个文件
                  </span>
                </div>
              </header>
              <div class="publish-media-body">
                {mediaCount > 0 ? (
                  <>
                    <ul class="publish-file-list" aria-label="已选择素材">
                      {mediaSelection?.files.map((file, index) => (
                        <li key={`${index}-${file.name}`}>
                          <span class="publish-file-icon">
                            <Icon
                              name={contentForm === "video" ? "video" : "image"}
                              size={18}
                            />
                          </span>
                          <span class="publish-file-copy">
                            <strong title={file.name}>{file.name}</strong>
                            <small>{formatFileSize(file.size)}</small>
                          </span>
                          <span class="publish-file-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div class="publish-media-actions">
                      <span>
                        {formatFileSize(
                          mediaSelection?.files.reduce(
                            (total, file) => total + file.size,
                            0,
                          ) ?? 0,
                        )}{" "}
                        · 已选择 {mediaCount} 个文件
                      </span>
                      <button
                        class="secondary-button small-button"
                        type="button"
                        onClick={() => void selectMedia()}
                      >
                        重新选择
                      </button>
                      <button
                        class="icon-button"
                        type="button"
                        aria-label="清空素材"
                        title="清空素材"
                        onClick={() => setMediaSelection(undefined)}
                      >
                        <Icon name="delete" size={16} />
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    class="media-dropzone"
                    type="button"
                    onClick={() => void selectMedia()}
                  >
                    <span class="media-dropzone-icon">
                      <Icon name="add" size={22} />
                    </span>
                    <strong>
                      {contentForm === "video"
                        ? "点击选择视频"
                        : "点击选择图片"}
                    </strong>
                    <small>
                      从本地文件中选择
                      {mediaLimit ? `，最多 ${mediaLimit} 个文件` : ""}
                    </small>
                  </button>
                )}
                {mediaLimitExceeded && (
                  <p class="publish-field-error" role="alert">
                    当前平台最多支持 {mediaLimit} 个素材，请重新选择。
                  </p>
                )}
              </div>
            </section>

            <section
              class="editor-surface"
              aria-labelledby="content-editor-title"
            >
              <header class="surface-header">
                <div class="publish-section-heading">
                  <span class="publish-section-number" aria-hidden="true">
                    02
                  </span>
                  <div>
                    <h2 id="content-editor-title">编辑文案</h2>
                    <p>用标题、正文与话题表达你的内容</p>
                  </div>
                </div>
              </header>
              <div class="editor-fields">
                <label class="field-label" for="draft-title-input">
                  标题
                  <span
                    class={titleFeedback.exceeded ? "publish-error" : undefined}
                  >
                    {titleFeedback.label}
                  </span>
                </label>
                <input
                  id="draft-title-input"
                  maxlength={200}
                  placeholder="给内容起一个好标题"
                  value={title}
                  aria-invalid={titleFeedback.exceeded}
                  aria-describedby={
                    titleFeedback.exceeded ? "draft-title-error" : undefined
                  }
                  onInput={(event) => setTitle(event.currentTarget.value)}
                />
                {titleFeedback.exceeded && (
                  <small
                    id="draft-title-error"
                    class="publish-field-error"
                    role="alert"
                  >
                    标题超出平台字数限制，请缩短标题。
                  </small>
                )}

                <label class="field-label" for="draft-body">
                  正文
                  <span
                    class={bodyFeedback.exceeded ? "publish-error" : undefined}
                  >
                    {bodyFeedback.label}
                  </span>
                </label>
                <textarea
                  id="draft-body"
                  maxlength={20000}
                  rows={8}
                  placeholder="分享你的想法、故事或灵感…"
                  value={body}
                  aria-invalid={bodyFeedback.exceeded}
                  aria-describedby={
                    bodyFeedback.exceeded ? "draft-body-error" : undefined
                  }
                  onInput={(event) => setBody(event.currentTarget.value)}
                />
                {bodyFeedback.exceeded && (
                  <small
                    id="draft-body-error"
                    class="publish-field-error"
                    role="alert"
                  >
                    正文（含标签）超出平台字数限制，请精简内容。
                  </small>
                )}

                <label class="field-label" for="draft-tags">
                  话题标签
                  <span class={tagLimitExceeded ? "publish-error" : undefined}>
                    {requestedTags.length}
                    {capability?.tagPolicy?.maxCount
                      ? ` / ${capability.tagPolicy.maxCount}`
                      : ""}{" "}
                    个话题
                  </span>
                </label>
                <textarea
                  id="draft-tags"
                  class="tags-input"
                  maxlength={1000}
                  rows={2}
                  placeholder="例如：内容创作，效率工具"
                  value={tags}
                  aria-invalid={tagLimitExceeded}
                  aria-describedby="draft-tags-hint"
                  onInput={(event) => setTags(event.currentTarget.value)}
                />
                <small
                  id="draft-tags-hint"
                  class={
                    tagLimitExceeded
                      ? "publish-field-error"
                      : "publish-field-hint"
                  }
                >
                  {tagLimitExceeded
                    ? `当前平台最多支持 ${capability?.tagPolicy?.maxCount} 个标签`
                    : "用逗号或换行分隔，标签会随正文一起发布。"}
                </small>
              </div>
            </section>
          </div>

          <aside
            class="publish-inspector"
            aria-labelledby="publish-settings-title"
          >
            <header class="surface-header">
              <div class="publish-section-heading">
                <span class="publish-section-number" aria-hidden="true">
                  03
                </span>
                <h2 id="publish-settings-title">发布设置</h2>
              </div>
            </header>
            <section
              class="inspector-section"
              aria-labelledby="submission-mode-title"
            >
              <h3 id="submission-mode-title">提交方式</h3>
              <label
                class={`radio-option${submissionMode === "manual_confirmation" ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="submission-mode"
                  value="manual_confirmation"
                  checked={submissionMode === "manual_confirmation"}
                  disabled={
                    !capability?.submissionModes.includes("manual_confirmation")
                  }
                  onChange={() => setSubmissionMode("manual_confirmation")}
                />
                <span>
                  <strong>
                    人工确认 <em>推荐</em>
                  </strong>
                  <small>填充草稿，检查后手动发布</small>
                </span>
              </label>
              <label
                class={`radio-option${submissionMode === "automatic" ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="submission-mode"
                  value="automatic"
                  checked={submissionMode === "automatic"}
                  disabled={
                    Boolean(context.recreatedDraft) ||
                    !capability?.submissionModes.includes("automatic")
                  }
                  onChange={() => setSubmissionMode("automatic")}
                />
                <span>
                  <strong>自动提交</strong>
                  <small>填充完成后直接提交到平台</small>
                </span>
              </label>
            </section>
            <section
              class="inspector-section"
              aria-labelledby="publish-summary-title"
            >
              <h3 id="publish-summary-title">本次发布</h3>
              <dl class="publish-summary">
                <div>
                  <dt>目标平台</dt>
                  <dd>{platform?.displayName ?? "—"}</dd>
                </div>
                <div>
                  <dt>发布账号</dt>
                  <dd title={accountName}>{accountName ?? "—"}</dd>
                </div>
                <div>
                  <dt>内容类型</dt>
                  <dd>{contentForm === "video" ? "视频" : "图文"}</dd>
                </div>
                <div>
                  <dt>素材数量</dt>
                  <dd>{mediaCount ? `${mediaCount} 个文件` : "尚未选择"}</dd>
                </div>
              </dl>
            </section>
            <div class="publish-action-area">
              <p
                id="publish-action-hint"
                class={hasHardConstraintViolation ? "publish-error" : undefined}
                aria-live="polite"
              >
                {actionHint}
              </p>
              <button
                class="primary-action"
                type="submit"
                aria-describedby="publish-action-hint"
                disabled={
                  submissionInFlight ||
                  hasHardConstraintViolation ||
                  !capability ||
                  !mediaCount
                }
              >
                <Icon name="publish" size={17} />
                {submissionInFlight
                  ? "正在准备…"
                  : submissionMode === "manual_confirmation"
                    ? "准备发布草稿"
                    : "开始发布"}
              </button>
              <span class="publish-action-note">
                发布进度可随时在发布记录中查看
              </span>
            </div>
          </aside>
        </div>
      </fieldset>
    </form>
  );
}

function renderPublishResult(
  context: AppContext,
  update: PublishResultUpdate,
): void {
  if (update.status === "verification_required") {
    context.setStatus(
      `${update.message ?? "平台要求安全验证"}，请在浏览器中完成验证`,
      "error",
    );
  } else if (update.status === "verifying") {
    context.setStatus(update.message ?? "平台已受理，正在确认作品…", "busy");
  } else if (update.status === "submission_attempted") {
    context.setStatus(
      update.message ?? "已尝试提交，正在等待平台结果…",
      "busy",
    );
  } else if (update.status === "published") {
    const identity = update.platformContentId
      ? `，作品 ID：${update.platformContentId}`
      : "";
    context.setStatus(`发布成功${identity}`);
  } else if (update.status === "failed") {
    context.setStatus(`发布失败：${update.message ?? "平台返回失败"}`, "error");
  } else if (update.status === "cancelled") {
    context.setStatus(update.message ?? "发布已取消");
  } else {
    context.setStatus(
      update.message ?? "发布结果暂时无法确认，请勿直接重复发布",
      "error",
    );
  }
}

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type PublishCapability = PlatformSummary["publishCapabilities"][number];
type TextConstraintKey = "title" | "body";

function textConstraintFeedback(
  capability: PublishCapability | undefined,
  key: TextConstraintKey,
  value: string,
): { label: string; exceeded: boolean } {
  const maximum =
    key === "title"
      ? capability?.constraints.titleMaxLength
      : capability?.constraints.bodyMaxLength;
  const effectiveMaximum = maximum ?? (key === "title" ? 200 : 20_000);
  return {
    label: `${value.length}/${effectiveMaximum}`,
    exceeded: maximum !== undefined && value.length > maximum,
  };
}

function parseTags(value: string): string[] {
  return value
    .split(/[,，\n]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}
