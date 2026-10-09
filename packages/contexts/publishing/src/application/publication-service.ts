import type { PublishResultEvent } from "@nedia-matrix/platform-sdk";
import { Publication } from "../domain/index.js";

import {
  toPublicationSummary,
  type OpenPublicationRequest,
  type PreparePublishDraftRequest,
  type PreparePublishDraftResult,
  type PublicationSnapshot,
  type PublicationSummary,
  publicationDisplayGroup,
  type PublicationAttentionResolution,
  type PublicationArchiveCleanupPolicy,
  type PublicationArchiveCleanupResult,
  type PublicationArchiveUsage,
  type PublicationTaskSummary,
  type PublicationQuery,
  type PublicationQueryResult,
  type RecreatedPublicationDraft,
} from "./index.js";
import {
  registerLocalMedia,
  type RegisterLocalMediaCommand,
  type RegisterLocalMediaResult,
} from "./local-media-registration.js";
import type { PublicationApplicationDependencies } from "./ports.js";
import {
  PublishDraftOrchestrator,
  type PrepareRemoteDraftRequest,
} from "./publish-draft-orchestrator.js";
import { requireSafePublicationUrl } from "./publication-link.js";

export interface PublicationUseCases {
  list(): PublicationSummary[];
  getTask?(publicationId: string): PublicationTaskSummary | undefined;
  recreateDraft?(publicationId: string): Promise<RecreatedPublicationDraft>;
  listTasks?(): PublicationTaskSummary[];
  queryTasks?(input: PublicationQuery): PublicationQueryResult;
  resolveAttention?(input: {
    publicationId: string;
    resolution: PublicationAttentionResolution;
    manualPlatformContentId?: string;
  }): PublicationTaskSummary;
  reopenAttention?(publicationId: string): PublicationTaskSummary;
  selectContent?(
    publicationId: string,
    externalContentId: string,
  ): PublicationTaskSummary;
  archiveUsage?(): Promise<PublicationArchiveUsage>;
  cleanupArchive?(
    policy: PublicationArchiveCleanupPolicy,
  ): Promise<PublicationArchiveCleanupResult>;
  setArchiveRetained?(
    publicationId: string,
    retained: boolean,
  ): PublicationTaskSummary;
  removeArchivePublication?(
    publicationId: string,
  ): Promise<PublicationArchiveCleanupResult>;
  wasDeleted?(requestId: string): boolean;
  openReview(request: OpenPublicationRequest): Promise<void>;
  publicationUrl(request: OpenPublicationRequest): string;
  prepareRemote(
    request: PrepareRemoteDraftRequest,
  ): Promise<PreparePublishDraftResult>;
  prepare(
    request: PreparePublishDraftRequest,
  ): Promise<PreparePublishDraftResult>;
  registerLocalMedia(
    command: RegisterLocalMediaCommand,
  ): RegisterLocalMediaResult;
  recordObservation(
    publicationId: string,
    result: PublishResultEvent,
    sequence?: number,
  ): PublicationSnapshot;
  recoverInterrupted(): PublicationSnapshot[];
}

export class PublicationService implements PublicationUseCases {
  private readonly draftPreparation: PublishDraftOrchestrator;

  constructor(
    private readonly dependencies: PublicationApplicationDependencies,
  ) {
    this.draftPreparation = new PublishDraftOrchestrator(dependencies);
  }

  list(): PublicationSummary[] {
    return this.dependencies.publishing.list().map(toPublicationSummary);
  }

  listTasks(): PublicationTaskSummary[] {
    return this.dependencies.publishing
      .list()
      .map((record) => this.taskSummary(record));
  }

  getTask(publicationId: string): PublicationTaskSummary | undefined {
    const record = this.dependencies.publishing.get(publicationId);
    return record ? this.taskSummary(record) : undefined;
  }

  async recreateDraft(
    publicationId: string,
  ): Promise<RecreatedPublicationDraft> {
    const source = this.requirePublication(publicationId);
    const state = source.publication.state;
    const attention = this.dependencies.attention?.get(publicationId);
    if (
      !["failed", "cancelled", "rejected", "published"].includes(state) &&
      !(
        state === "uncertain" &&
        attention?.resolution === "confirmed_not_published"
      )
    ) {
      throw new TypeError("This publication cannot be recreated yet");
    }
    if (
      this.dependencies.accountPublications.isActive(
        source.publication.accountId,
      )
    )
      throw new TypeError("An active publication cannot be recreated");
    const account = this.dependencies.accounts.require(
      source.publication.accountId,
    );
    if (account.lifecycle !== "active" || account.status !== "authenticated")
      throw new TypeError(
        "The source account is unavailable; choose and verify an active account first",
      );
    const platform = this.dependencies.platforms.require(
      source.publication.platformId,
    );
    const form = platform.publishing?.forms[source.contentForm];
    if (!form)
      throw new TypeError(
        "The current platform no longer supports this content form",
      );

    const resourceReferences: string[] = [];
    const files: Array<{
      name: string;
      size: number;
      role: PublicationSnapshot["assets"][number]["role"];
      order: number;
      mediaType: string | null;
      hash: string | null;
      downloadedAt: string | null;
      sourceAssetId: string;
      sourceOrigin: string | null;
      localRelativePath: string;
    }> = [];
    const unavailableAssets: string[] = [];
    for (const asset of source.assets) {
      const path =
        asset.localRelativePath && this.dependencies.resolveArchiveAssetPath
          ? await this.dependencies.resolveArchiveAssetPath(
              asset.localRelativePath,
            )
          : undefined;
      if (!path) {
        unavailableAssets.push(asset.name);
        continue;
      }
      resourceReferences.push(path);
      files.push({
        name: asset.name,
        size: asset.size,
        role: asset.role,
        order: asset.order,
        mediaType: asset.mediaType,
        hash: asset.hash,
        downloadedAt: asset.downloadedAt,
        sourceAssetId: asset.id,
        sourceOrigin: asset.sourceOrigin,
        localRelativePath: asset.localRelativePath!,
      });
    }
    if (source.assets.length === 0)
      unavailableAssets.push("原任务没有可复用素材");
    const mediaSelectionId =
      unavailableAssets.length === 0
        ? this.dependencies.mediaSelections.create({
            accountId: source.publication.accountId,
            contentForm: source.contentForm,
            resourceReferences,
            files,
          })
        : null;
    return {
      sourcePublicationId: publicationId,
      accountId: source.publication.accountId,
      contentForm: source.contentForm,
      title: source.contentRevision.title ?? "",
      body: source.contentRevision.body,
      tags: [...source.tags],
      mediaSelectionId,
      reusableAssets: files.map(({ name, size }) => ({ name, size })),
      unavailableAssets,
    };
  }

  queryTasks(input: PublicationQuery): PublicationQueryResult {
    validatePublicationQuery(input);
    const query = this.dependencies.query;
    if (!query) {
      const all = this.listTasks();
      const base = all.filter(
        (item) =>
          (!input.platformId || item.platformId === input.platformId) &&
          (!input.accountId || item.accountId === input.accountId) &&
          (!input.keyword?.trim() ||
            `${item.title ?? ""} ${item.body}`
              .toLowerCase()
              .includes(input.keyword.trim().toLowerCase())),
      );
      const filtered = base.filter(
        (item) =>
          (input.view === "all" ||
            ["action_required", "in_progress"].includes(
              item.effectiveDisplayGroup,
            ) ||
            (item.effectiveDisplayGroup === "attention_required" &&
              item.attentionResolution === null)) &&
          (!input.group || item.effectiveDisplayGroup === input.group) &&
          (!input.state || item.state === input.state) &&
          (!input.createdFrom || item.createdAt >= input.createdFrom) &&
          (!input.createdTo || item.createdAt <= input.createdTo),
      );
      return {
        items: filtered.slice(0, input.limit ?? 30),
        counts: countTaskGroups(all),
        tabCounts: countTaskGroups(base),
        total: filtered.length,
        nextCursor: null,
      };
    }
    const result = query.query(input);
    return {
      items: result.records.map((record) => this.taskSummary(record)),
      counts: result.counts,
      tabCounts: result.tabCounts,
      total: result.total,
      nextCursor: result.nextCursor,
    };
  }

  resolveAttention(input: {
    publicationId: string;
    resolution: PublicationAttentionResolution;
    manualPlatformContentId?: string;
  }): PublicationTaskSummary {
    const repository = this.requireAttentionRepository();
    const record = this.requirePublication(input.publicationId);
    this.validateAttentionResolution(
      record.publication.state,
      input.resolution,
    );
    const manualPlatformContentId = input.manualPlatformContentId?.trim();
    if (input.resolution === "confirmed_published") {
      if (
        !manualPlatformContentId ||
        manualPlatformContentId.length > 256 ||
        /[\s\u0000-\u001f]/u.test(manualPlatformContentId)
      )
        throw new TypeError("A valid platform work ID is required");
    } else if (input.manualPlatformContentId !== undefined) {
      throw new TypeError(
        "A work ID is only accepted for confirmed publication",
      );
    }
    const resolvedAt = new Date().toISOString();
    repository.set({
      publicationId: input.publicationId,
      resolution: input.resolution,
      resolvedAt,
      manualPlatformContentId: manualPlatformContentId ?? null,
    });
    return this.taskSummary(record);
  }

  reopenAttention(publicationId: string): PublicationTaskSummary {
    const repository = this.requireAttentionRepository();
    const record = this.requirePublication(publicationId);
    if (!["failed", "uncertain"].includes(record.publication.state)) {
      throw new TypeError(
        "Only failed or uncertain publications can be reopened",
      );
    }
    repository.remove(publicationId);
    return this.taskSummary(record);
  }

  selectContent(
    publicationId: string,
    externalContentId: string,
  ): PublicationTaskSummary {
    const record = this.requirePublication(publicationId);
    const attention = this.dependencies.attention?.get(publicationId);
    if (
      record.publication.state !== "published" &&
      !(
        record.publication.state === "uncertain" &&
        attention?.resolution === "confirmed_published"
      )
    )
      throw new TypeError("Only completed publications can select a work");
    if (!externalContentId.trim())
      throw new TypeError("A platform work ID is required");
    if (!this.dependencies.selection)
      throw new Error("Publication work selection is unavailable");
    this.dependencies.selection.selectContent(publicationId, externalContentId);
    return this.taskSummary(record);
  }

  async openReview(request: OpenPublicationRequest): Promise<void> {
    if (
      !request ||
      typeof request.publicationId !== "string" ||
      !this.dependencies.publishing.get(request.publicationId)
    ) {
      throw new TypeError("Publication does not exist");
    }
    await this.dependencies.browser.focusPublication(request.publicationId);
  }

  publicationUrl(request: OpenPublicationRequest): string {
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.publicationId !== "string" ||
      request.publicationId.length === 0
    ) {
      throw new TypeError("Invalid publication request");
    }
    const record = this.dependencies.publishing.get(request.publicationId);
    if (!record) throw new TypeError("Publication does not exist");
    const platform = this.dependencies.platforms.require(
      record.publication.platformId,
    );
    return requireSafePublicationUrl(record, platform);
  }

  prepareRemote(
    request: PrepareRemoteDraftRequest,
  ): Promise<PreparePublishDraftResult> {
    return this.draftPreparation.prepareRemoteDraft(request);
  }

  prepare(
    request: PreparePublishDraftRequest,
  ): Promise<PreparePublishDraftResult> {
    return this.draftPreparation.prepareDraft(request);
  }

  registerLocalMedia(
    command: RegisterLocalMediaCommand,
  ): RegisterLocalMediaResult {
    return registerLocalMedia(command, this.dependencies);
  }

  recordObservation(
    publicationId: string,
    result: PublishResultEvent,
    sequence?: number,
  ): PublicationSnapshot {
    return this.dependencies.publishing.recordObservation(
      publicationId,
      result,
      sequence,
    );
  }

  recoverInterrupted(): PublicationSnapshot[] {
    return this.dependencies.publishing.recoverInterrupted();
  }

  private taskSummary(record: PublicationSnapshot): PublicationTaskSummary {
    const summary = toPublicationSummary(record);
    const attention = this.dependencies.attention?.get(record.publication.id);
    return {
      ...summary,
      displayGroup: publicationDisplayGroup(summary.state),
      effectiveDisplayGroup:
        summary.state === "uncertain" &&
        attention?.resolution === "confirmed_published" &&
        attention.manualPlatformContentId
          ? "completed"
          : publicationDisplayGroup(summary.state),
      attentionResolution: attention?.resolution ?? null,
      attentionResolvedAt: attention?.resolvedAt ?? null,
      manualPlatformContentId: attention?.manualPlatformContentId ?? null,
      selectedPlatformContentId:
        this.dependencies.selection?.selectedContentId(record.publication.id) ??
        null,
      attentionHistory:
        this.dependencies.attention?.history?.(summary.id) ?? [],
      archiveRemovable: Publication.rehydrate(record).canBeRemovedFromArchive(
        this.dependencies.accountPublications.isActive(
          record.publication.accountId,
        ) ||
          (this.dependencies.hasActivePublication?.(record.publication.id) ??
            false),
      ),
    };
  }

  private requirePublication(publicationId: string): PublicationSnapshot {
    const record = this.dependencies.publishing.get(publicationId);
    if (!record) throw new TypeError("Publication does not exist");
    return record;
  }

  private requireAttentionRepository() {
    if (!this.dependencies.attention)
      throw new Error("Publication attention storage is unavailable");
    return this.dependencies.attention;
  }

  private validateAttentionResolution(
    state: PublicationSnapshot["publication"]["state"],
    resolution: PublicationAttentionResolution,
  ): void {
    const allowed =
      state === "failed"
        ? ["acknowledged_failure", "dismissed"]
        : state === "uncertain"
          ? ["confirmed_published", "confirmed_not_published", "dismissed"]
          : [];
    if (!allowed.includes(resolution))
      throw new TypeError("Invalid publication attention resolution");
  }
}

function validatePublicationQuery(input: PublicationQuery): void {
  if (!input || (input.view !== "pending" && input.view !== "all"))
    throw new TypeError("Invalid publication query view");
  for (const [name, value] of [
    ["platformId", input.platformId],
    ["accountId", input.accountId],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      throw new TypeError(`Invalid publication query ${name}`);
  }
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
  )
    throw new TypeError("Publication query limit must be between 1 and 100");
  const groups = [
    "action_required",
    "in_progress",
    "attention_required",
    "completed",
    "closed",
  ];
  if (input.group !== undefined && !groups.includes(input.group))
    throw new TypeError("Invalid publication query group");
  const states = [
    "draft",
    "validated",
    "scheduled",
    "preparing",
    "awaiting_confirmation",
    "submitting",
    "verifying",
    "retrying",
    "published",
    "uncertain",
    "failed",
    "rejected",
    "cancelled",
  ];
  if (input.state !== undefined && !states.includes(input.state))
    throw new TypeError("Invalid publication query state");
  for (const [name, value] of [
    ["createdFrom", input.createdFrom],
    ["createdTo", input.createdTo],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      throw new TypeError(`Invalid publication query ${name}`);
  }
  if (input.cursor !== undefined && typeof input.cursor !== "string")
    throw new TypeError("Invalid publication query cursor");
  if (input.keyword !== undefined) {
    if (typeof input.keyword !== "string")
      throw new TypeError("Invalid publication query keyword");
    if (Array.from(input.keyword.trim()).length > 100)
      throw new TypeError("Publication query keyword is too long");
  }
  if (
    input.createdFrom !== undefined &&
    input.createdTo !== undefined &&
    Date.parse(input.createdFrom) > Date.parse(input.createdTo)
  ) {
    throw new TypeError(
      "Publication query createdFrom must not exceed createdTo",
    );
  }
}

function countTaskGroups(
  items: readonly PublicationTaskSummary[],
): PublicationQueryResult["counts"] {
  return items.reduce(
    (counts, item) => {
      counts.all += 1;
      if (item.effectiveDisplayGroup === "action_required")
        counts.actionRequired += 1;
      if (
        item.effectiveDisplayGroup === "attention_required" &&
        item.attentionResolution === null
      ) {
        counts.openAttentionRequired += 1;
      }
      if (item.effectiveDisplayGroup === "attention_required")
        counts.attentionRequired += 1;
      if (item.effectiveDisplayGroup === "in_progress") counts.inProgress += 1;
      if (item.effectiveDisplayGroup === "completed") {
        counts.completed += 1;
        if (item.attentionResolution === "confirmed_published")
          counts.completedManual += 1;
        else counts.completedAutomatic += 1;
      }
      if (item.effectiveDisplayGroup === "closed") counts.closed += 1;
      counts.pending =
        counts.actionRequired +
        counts.openAttentionRequired +
        counts.inProgress;
      return counts;
    },
    {
      actionRequired: 0,
      openAttentionRequired: 0,
      inProgress: 0,
      completed: 0,
      completedAutomatic: 0,
      completedManual: 0,
      attentionRequired: 0,
      closed: 0,
      all: 0,
      pending: 0,
    },
  );
}

export type { PrepareRemoteDraftRequest };
export type {
  RegisterLocalMediaCommand,
  RegisterLocalMediaResult,
} from "./local-media-registration.js";
