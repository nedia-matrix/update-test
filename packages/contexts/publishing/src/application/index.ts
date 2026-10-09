import {
  Publication,
  type PublicationAssetSnapshot as CorePublicationAssetSnapshot,
  type PublicationSnapshot as DomainPublicationSnapshot,
  type PublicationState,
  type SubmissionEvidence as CoreSubmissionEvidence,
} from "../domain/index.js";
import type { PublishResultEvent } from "@nedia-matrix/platform-sdk";

import type {
  SubmissionMode as CoreSubmissionMode,
  SupportedPublishContentForm,
} from "../domain/index.js";

export type PublishContentForm = SupportedPublishContentForm;
export type PublicationContentForm = PublishContentForm;
export type SubmissionMode = CoreSubmissionMode;
export type PublicationStatus = PublicationState;
export type SubmissionEvidence = CoreSubmissionEvidence;
export type PublicationAssetSnapshot = CorePublicationAssetSnapshot;
export type PublicationSnapshot = DomainPublicationSnapshot;

export interface PublicationSummary {
  id: string;
  requestId: string;
  sourcePublicationId?: string;
  platformId: string;
  accountId: string;
  contentForm: PublishContentForm;
  title: string | null;
  body: string;
  tags?: readonly string[];
  assets: readonly { name: string; size: number }[];
  state: PublicationStatus;
  transitions: readonly {
    from: PublicationStatus;
    to: PublicationStatus;
    occurredAt: string;
    reason: string | null;
  }[];
  rulesVersion: string;
  retained: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
  platformContentId: string | null;
  platformContentUrl: string | null;
}

export type PublicationDisplayGroup =
  | "action_required"
  | "in_progress"
  | "attention_required"
  | "completed"
  | "closed";

export function publicationDisplayGroup(
  state: PublicationStatus,
): PublicationDisplayGroup {
  switch (state) {
    case "awaiting_confirmation":
      return "action_required";
    case "draft":
    case "validated":
    case "scheduled":
    case "preparing":
    case "submitting":
    case "verifying":
    case "retrying":
      return "in_progress";
    case "uncertain":
    case "failed":
      return "attention_required";
    case "published":
      return "completed";
    case "rejected":
    case "cancelled":
      return "closed";
  }
}

export const publicationAttentionResolutions = [
  "acknowledged_failure",
  "recreated",
  "confirmed_published",
  "confirmed_not_published",
  "dismissed",
] as const;

export type PublicationAttentionResolution =
  (typeof publicationAttentionResolutions)[number];

export interface PublicationAttentionRecord {
  publicationId: string;
  resolution: PublicationAttentionResolution;
  resolvedAt: string;
  manualPlatformContentId?: string | null;
}

export interface PublicationAttentionEvent extends PublicationAttentionRecord {
  reopened: boolean;
}

export interface PublicationAttentionRepository {
  get(publicationId: string): PublicationAttentionRecord | undefined;
  set(record: PublicationAttentionRecord): void;
  remove(publicationId: string): void;
  history?(publicationId: string): readonly PublicationAttentionEvent[];
}

export interface PublicationTaskSummary extends PublicationSummary {
  displayGroup: PublicationDisplayGroup;
  effectiveDisplayGroup: PublicationDisplayGroup;
  attentionResolution: PublicationAttentionResolution | null;
  attentionResolvedAt: string | null;
  manualPlatformContentId: string | null;
  selectedPlatformContentId?: string | null;
  attentionHistory: readonly PublicationAttentionEvent[];
  archiveRemovable: boolean;
}

export interface PublicationQuery {
  view: "pending" | "all";
  platformId?: string;
  accountId?: string;
  group?: PublicationDisplayGroup;
  state?: PublicationStatus;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
  limit?: number;
}

export interface PublicationTaskCounts {
  actionRequired: number;
  openAttentionRequired: number;
  inProgress: number;
  completed: number;
  completedAutomatic: number;
  completedManual: number;
  attentionRequired: number;
  closed: number;
  all: number;
  pending: number;
}

export interface PublicationQueryResult {
  items: PublicationTaskSummary[];
  counts: PublicationTaskCounts;
  tabCounts: PublicationTaskCounts;
  total: number;
  nextCursor: string | null;
}

export interface OpenPublicationRequest {
  publicationId: string;
}

export interface SelectPublishMediaRequest {
  accountId: string;
  contentForm: PublishContentForm;
}

export type SelectPublishMediaResult =
  | { status: "cancelled" }
  | {
      status: "selected";
      selectionId: string;
      files: readonly { name: string; size: number }[];
    };

export interface PreparePublishDraftRequest {
  accountId: string;
  requestId?: string;
  sourcePublicationId?: string;
  contentForm: PublishContentForm;
  mediaSelectionId: string;
  title: string;
  body: string;
  tags?: readonly string[];
  submissionMode?: SubmissionMode;
}

export interface RecreatedPublicationDraft {
  sourcePublicationId: string;
  accountId: string;
  contentForm: PublicationContentForm;
  title: string;
  body: string;
  tags: readonly string[];
  mediaSelectionId: string | null;
  reusableAssets: readonly { name: string; size: number }[];
  unavailableAssets: readonly string[];
}

export type PreparePublishDraftResult =
  | {
      status: "ready_for_review";
      mediaCount: number;
      profileId: string;
      publishObservationId: string | null;
      publicationId: string;
    }
  | {
      status: "submission_started";
      mediaCount: number;
      profileId: string;
      publishObservationId: string;
      publicationId: string;
    }
  | {
      status: "already_started";
      publicationId: string;
      state: PublicationStatus;
    }
  | { status: "account_busy" }
  | { status: "login_required" }
  | { status: "account_unknown"; reason: string }
  | {
      status: "failed";
      publicationId?: string;
      code: string;
      message: string;
      evidenceId: string | null;
      traceId?: string;
    }
  | {
      status: "uncertain";
      code: string;
      message: string;
      evidenceId: string | null;
      publicationId: string;
      traceId?: string;
    };

export type PublishResultStatus = PublishResultEvent["kind"];

export interface PublishResultUpdate {
  observationId: string;
  publicationId: string;
  accountId: string;
  status: PublishResultStatus;
  message: string | null;
  platformContentId: string | null;
  platformContentUrl: string | null;
}

export function toPublicationSummary(
  record: PublicationSnapshot,
): PublicationSummary {
  const { publication, contentRevision } = record;
  return {
    id: publication.id,
    requestId: record.requestId,
    ...(record.sourcePublicationId
      ? { sourcePublicationId: record.sourcePublicationId }
      : {}),
    platformId: publication.platformId,
    accountId: publication.accountId,
    contentForm: record.contentForm,
    title: contentRevision.title ?? null,
    body: contentRevision.body,
    tags: [...record.tags],
    assets: record.assets.map(({ name, size }) => ({ name, size })),
    state: publication.state,
    transitions: publication.transitions.map((transition) => ({
      ...transition,
      reason: transition.reason ?? null,
    })),
    rulesVersion: record.rulesVersion,
    retained: record.retained,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastMessage: record.lastMessage ?? null,
    platformContentId: publication.platformContentId ?? null,
    platformContentUrl: publication.platformContentUrl ?? null,
  };
}

export interface PublicationRepository {
  list(): PublicationSnapshot[];
  get(publicationId: string): PublicationSnapshot | undefined;
  findByRequestId(requestId: string): PublicationSnapshot | undefined;
  save(record: PublicationSnapshot): void;
}

export interface StartPublicationInput {
  requestId: string;
  sourcePublicationId?: string;
  platformId: string;
  accountId: string;
  contentForm: PublicationContentForm;
  title: string;
  body: string;
  tags?: readonly string[];
  submissionMode?: SubmissionMode;
  assets: readonly (Pick<PublicationAssetSnapshot, "name" | "size"> &
    Partial<Omit<PublicationAssetSnapshot, "id" | "name" | "size">>)[];
  rulesVersion: string;
  qualification: {
    capability: Pick<
      import("@nedia-matrix/platform-sdk").PlatformPublishFormCapability,
      "constraints" | "submissionModes"
    >;
    body?: string;
    platformName?: string;
  };
}

export interface StartPreparationResult {
  record: PublicationSnapshot;
  started: boolean;
}

export interface PublishingClock {
  now(): Date;
}

export interface PublishingIdFactory {
  create(): string;
}

export class PublishingService {
  constructor(
    private readonly repository: PublicationRepository,
    private readonly clock: PublishingClock,
    private readonly ids: PublishingIdFactory,
  ) {}

  list(): PublicationSnapshot[] {
    return this.repository.list();
  }

  get(publicationId: string): PublicationSnapshot | undefined {
    return this.repository.get(publicationId);
  }

  startPreparation(input: StartPublicationInput): StartPreparationResult {
    const existing = this.repository.findByRequestId(input.requestId);
    if (existing) return { record: existing, started: false };
    const occurredAt = this.now();
    const publicationId = this.ids.create();
    const contentRevisionId = this.ids.create();
    const assets = input.assets.map((asset, order) => ({
      ...asset,
      id: this.ids.create(),
      role: asset.role ?? (input.contentForm === "video" ? "video" : "image"),
      order: asset.order ?? order,
      mediaType: asset.mediaType ?? null,
      hash: asset.hash ?? null,
      downloadedAt: asset.downloadedAt ?? null,
      sourceAssetId: asset.sourceAssetId ?? null,
      sourceOrigin: asset.sourceOrigin ?? null,
      localRelativePath: asset.localRelativePath ?? null,
    }));
    const record = Publication.start({
      requestId: input.requestId,
      ...(input.sourcePublicationId
        ? { sourcePublicationId: input.sourcePublicationId }
        : {}),
      publicationId,
      contentRevisionId,
      platformId: input.platformId,
      accountId: input.accountId,
      contentForm: input.contentForm,
      title: input.title,
      body: input.body,
      tags: [...(input.tags ?? [])],
      submissionMode: input.submissionMode ?? "manual_confirmation",
      assets,
      rulesVersion: input.rulesVersion,
      occurredAt,
      qualification: input.qualification,
    }).toSnapshot();
    const normalized: PublicationSnapshot = record;
    this.repository.save(normalized);
    return { record: normalized, started: true };
  }

  markAwaitingConfirmation(publicationId: string): PublicationSnapshot {
    return this.transition(publicationId, "awaiting_confirmation");
  }

  markSubmitting(publicationId: string): PublicationSnapshot {
    return this.transition(publicationId, "submitting");
  }

  markPreparationFailed(
    publicationId: string,
    message: string,
  ): PublicationSnapshot {
    return this.transition(publicationId, "failed", message);
  }

  markSubmissionUncertain(
    publicationId: string,
    message: string,
  ): PublicationSnapshot {
    const current = this.require(publicationId);
    if (current.publication.state === "uncertain") return current;
    return this.transition(publicationId, "uncertain", message);
  }

  recordObservation(
    publicationId: string,
    result: PublishResultEvent,
    sequence?: number,
    expectedIdentity?: { accountId: string; platformId: string },
  ): PublicationSnapshot {
    const current = this.require(publicationId);
    const currentSequence = current.lastObservationSequence ?? 0;
    const next = Publication.rehydrate(current).recordObservation(
      result,
      this.now(),
      sequence,
      expectedIdentity,
    );
    if (sequence !== undefined && sequence <= currentSequence) return current;
    return this.save(next);
  }

  recoverInterrupted(): PublicationSnapshot[] {
    const recovered: PublicationSnapshot[] = [];
    for (const record of this.repository.list()) {
      const next = Publication.rehydrate(record).recoverInterrupted(this.now());
      if (next) recovered.push(this.save(next));
    }
    return recovered;
  }

  private transition(
    publicationId: string,
    state: PublicationState,
    message?: string,
  ): PublicationSnapshot {
    const current = this.require(publicationId);
    const aggregate = Publication.rehydrate(current);
    const occurredAt = this.now();
    const next =
      state === "awaiting_confirmation"
        ? aggregate.awaitConfirmation(occurredAt)
        : state === "submitting"
          ? aggregate.beginSubmission(occurredAt)
          : state === "failed"
            ? aggregate.failPreparation(message ?? "发布准备失败", occurredAt)
            : state === "uncertain"
              ? aggregate.markSubmissionUncertain(
                  message ?? "发布结果不确定",
                  occurredAt,
                )
              : aggregate.recordObservation(
                  {
                    kind: state === "cancelled" ? "cancelled" : "failed",
                    message: message ?? "状态更新",
                  },
                  occurredAt,
                );
    return this.save(next);
  }

  private require(publicationId: string): PublicationSnapshot {
    const record = this.repository.get(publicationId);
    if (!record) throw new TypeError("Publication does not exist");
    return record;
  }

  private save(record: PublicationSnapshot): PublicationSnapshot {
    this.repository.save(record);
    return record;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

export { AccountPublicationLock } from "./account-publication-lock.js";
export {
  PublicationArchiveMaintenance,
  type PublicationArchiveCleanupPolicy,
  type PublicationArchiveCleanupResult,
  type PublicationArchiveUsage,
} from "./publication-archive-maintenance.js";
export { requireSafePublicationUrl } from "./publication-link.js";
export {
  PublicationService,
  type PublicationUseCases,
  type PrepareRemoteDraftRequest,
  type RegisterLocalMediaCommand,
  type RegisterLocalMediaResult,
} from "./publication-service.js";
export type { LocalMediaResource } from "./local-media-registration.js";
export {
  toPublishResultUpdate,
  type PublishObservationEvent,
} from "./publication-observation.js";
export {
  MediaSelectionUnavailableError,
  type AccountPublicationPort,
  type DownloadedPublicationAsset,
  type ManagedPublishObservation,
  type MediaSelection,
  type MediaSelectionPort,
  type PublicationApplicationDependencies,
  type PublicationAccountView,
  type PublicationArchiveAssetStore,
  type PublicationArchiveRepository,
  type PublicationBrowserPage,
  type PublicationBrowserPort,
  type PublicationNoticePort,
  type PublicationStatePort,
  type PublicationQueryPort,
  type PublishDiagnosticSink,
  type PublishAutomationDiagnosticEvent,
  type PublishAutomationDiagnosticPort,
  type PublishAutomationDiagnosticTrace,
  type PublishFailureClassifier,
  type PublishMonitorClock,
  type PublishObservationPort,
  type PublishWorkflowExecutor,
  type RemotePublicationAsset,
  type RemotePublicationAssetPort,
  type StoredPublicationAsset,
} from "./ports.js";
