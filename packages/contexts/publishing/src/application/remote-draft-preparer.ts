import {
  accountSubmissionMode,
  resolveAccountPlatform,
  resolvePlatformSettings,
  type PlatformSettings,
} from "@nedia-matrix/platform-sdk";
import type { PreparePublishDraftRequest } from "./index.js";
import type { PublicationApplicationDependencies } from "./ports.js";
import {
  type PrepareRemoteDraftRequest,
  validateRemoteAssetsForForm,
  validateRemoteDraftRequest,
} from "./publish-request-validator.js";

type RemoteDraftDependencies = Pick<
  PublicationApplicationDependencies,
  "accounts" | "mediaSelections" | "platforms" | "publishing" | "remoteAssets"
>;

export async function prepareRemoteDraft<Result>(
  request: PrepareRemoteDraftRequest,
  dependencies: RemoteDraftDependencies,
  prepareDraft: (
    request: PreparePublishDraftRequest,
    settings: PlatformSettings,
  ) => Promise<Result>,
) {
  const requestId = validateRemoteDraftRequest(request);
  const existing = dependencies.publishing
    .list()
    .find((record) => record.requestId === requestId);
  if (existing) {
    return {
      status: "already_started",
      publicationId: existing.publication.id,
      state: existing.publication.state,
    } as const;
  }

  const account = dependencies.accounts.require(request.accountId);
  if (account.lifecycle !== "active") {
    return {
      status: "account_unknown",
      reason: "账号身份仍在识别，暂不能创建发布任务",
    } as const;
  }
  const platform = resolveAccountPlatform(dependencies.platforms, account);
  const settings = resolvePlatformSettings(platform, account.settings);
  const form = platform.publishing?.forms[request.contentForm];
  if (!form) throw new TypeError("Platform does not support this draft");
  const submissionMode = accountSubmissionMode({ settings });
  if (!form.submissionModes.includes(submissionMode))
    throw new TypeError(
      `当前账号不支持配置的 Web 发布提交方式 ${submissionMode}，请在 Desktop 账号设置中调整`,
    );
  const maxMediaCount = form.constraints.mediaMaxCount;
  if (request.assets.length === 0) {
    throw new TypeError("A draft must contain at least one media file");
  }
  if (maxMediaCount !== undefined && request.assets.length > maxMediaCount) {
    throw new TypeError(
      `A draft can contain at most ${maxMediaCount} media files`,
    );
  }
  const orderedAssets = validateRemoteAssetsForForm(
    request.contentForm,
    request.assets,
  );

  const downloaded = await dependencies.remoteAssets.download(
    requestId,
    orderedAssets,
  );
  const selectionId = dependencies.mediaSelections.create({
    accountId: request.accountId,
    contentForm: request.contentForm,
    resourceReferences: downloaded.map(
      ({ resourceReference }) => resourceReference,
    ),
    files: downloaded.map(
      ({
        created: _created,
        resourceReference: _resourceReference,
        ...asset
      }) => asset,
    ),
  });
  try {
    const result = await prepareDraft(
      {
        accountId: request.accountId,
        requestId,
        contentForm: request.contentForm,
        mediaSelectionId: selectionId,
        title: request.title,
        body: request.body,
        tags: request.tags,
        submissionMode,
      },
      settings,
    );
    if (
      !dependencies.publishing
        .list()
        .some((record) => record.requestId === requestId)
    ) {
      dependencies.mediaSelections.consume(selectionId);
    }
    await releaseAssetsWithoutPublication(requestId, downloaded, dependencies);
    return result;
  } catch (error) {
    dependencies.mediaSelections.consume(selectionId);
    await releaseAssetsWithoutPublication(requestId, downloaded, dependencies);
    throw error;
  }
}

async function releaseAssetsWithoutPublication(
  requestId: string,
  downloaded: Awaited<
    ReturnType<RemoteDraftDependencies["remoteAssets"]["download"]>
  >,
  dependencies: RemoteDraftDependencies,
): Promise<void> {
  const publications = dependencies.publishing.list();
  if (publications.some((record) => record.requestId === requestId)) return;
  const referencedRelativePaths = new Set(
    publications.flatMap((record) =>
      record.assets.flatMap(({ localRelativePath }) =>
        localRelativePath === null ? [] : [localRelativePath],
      ),
    ),
  );
  await dependencies.remoteAssets.discardUnreferenced(
    downloaded,
    referencedRelativePaths,
  );
}
