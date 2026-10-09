import {
  publishContentForms,
  submissionModes,
  type PlatformPublishFormCapability,
} from "@nedia-matrix/platform-sdk";
import { z } from "zod";

export const supportedPublishContentForms = publishContentForms.filter(
  (form): form is Exclude<(typeof publishContentForms)[number], "longText"> =>
    form !== "longText",
);
export const publishContentFormSchema = z.enum(supportedPublishContentForms);
export type SupportedPublishContentForm = z.infer<
  typeof publishContentFormSchema
>;
export type PublishContentForm = SupportedPublishContentForm;

export const submissionModeSchema = z.enum(submissionModes);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
export const publicationSubmissionModes = [
  ...submissionModes,
  "legacy_unknown",
] as const;
export type PublicationSubmissionMode =
  (typeof publicationSubmissionModes)[number];

export interface ContentRevision {
  id: string;
  contentItemId: string;
  revision: number;
  title?: string;
  body: string;
  assetIds: readonly string[];
  createdAt: string;
}

export function createContentRevision(
  revision: ContentRevision,
): Readonly<ContentRevision> {
  if (revision.revision < 1 || !Number.isInteger(revision.revision)) {
    throw new RangeError("Content revision number must be a positive integer");
  }

  if (
    revision.body.trim().length === 0 &&
    (revision.title?.trim().length ?? 0) === 0 &&
    revision.assetIds.length === 0
  ) {
    throw new TypeError("Content revision cannot be empty");
  }

  return Object.freeze({
    ...revision,
    assetIds: Object.freeze([...revision.assetIds]),
  });
}

export const publicationStates = [
  "draft",
  "validated",
  "scheduled",
  "preparing",
  "awaiting_confirmation",
  "submitting",
  "verifying",
  "published",
  "uncertain",
  "failed",
  "retrying",
  "rejected",
  "cancelled",
] as const;

export type PublicationState = (typeof publicationStates)[number];

export interface PublicationTransition {
  from: PublicationState;
  to: PublicationState;
  occurredAt: string;
  reason?: string;
}

export interface PublicationStateSnapshot {
  id: string;
  platformId: string;
  accountId: string;
  contentRevisionId: string;
  state: PublicationState;
  transitions: readonly PublicationTransition[];
  platformContentId?: string;
  platformContentUrl?: string;
}

const allowedTransitions: Readonly<
  Record<PublicationState, readonly PublicationState[]>
> = {
  draft: ["validated", "cancelled"],
  validated: ["scheduled", "preparing", "submitting", "rejected", "cancelled"],
  scheduled: ["preparing", "submitting", "cancelled"],
  preparing: ["awaiting_confirmation", "submitting", "failed", "cancelled"],
  awaiting_confirmation: [
    "submitting",
    "verifying",
    "published",
    "uncertain",
    "failed",
    "cancelled",
  ],
  submitting: ["verifying", "uncertain", "failed", "cancelled"],
  verifying: ["published", "uncertain", "failed"],
  published: [],
  uncertain: ["verifying", "published", "failed"],
  failed: ["retrying", "cancelled"],
  retrying: ["submitting", "cancelled"],
  rejected: [],
  cancelled: [],
};

export class InvalidPublicationTransitionError extends Error {
  constructor(
    readonly from: PublicationState,
    readonly to: PublicationState,
  ) {
    super(`Cannot transition publication from ${from} to ${to}`);
    this.name = "InvalidPublicationTransitionError";
  }
}

export function createPublication(
  input: Omit<PublicationStateSnapshot, "state" | "transitions">,
): Readonly<PublicationStateSnapshot> {
  return Object.freeze({
    ...input,
    state: "draft",
    transitions: Object.freeze([]),
  });
}

export function transitionPublication(
  publication: Readonly<PublicationStateSnapshot>,
  to: PublicationState,
  occurredAt: string,
  reason?: string,
): Readonly<PublicationStateSnapshot> {
  if (!allowedTransitions[publication.state].includes(to)) {
    throw new InvalidPublicationTransitionError(publication.state, to);
  }

  const transition: PublicationTransition = {
    from: publication.state,
    to,
    occurredAt,
    ...(reason === undefined ? {} : { reason }),
  };

  return Object.freeze({
    ...publication,
    state: to,
    transitions: Object.freeze([...publication.transitions, transition]),
  });
}

export const submissionEvidences = [
  "none",
  "submission_attempted",
  "verification_observed",
  "accepted",
  "legacy_unknown",
] as const;
export type SubmissionEvidence = (typeof submissionEvidences)[number];

export const publicationAssetRoles = [
  "image",
  "video",
  "cover",
  "inline_image",
] as const;
export type PublicationAssetRole = (typeof publicationAssetRoles)[number];

const archiveRemovableStates: readonly PublicationState[] = [
  "published",
  "failed",
  "uncertain",
  "cancelled",
  "rejected",
];

export interface PublicationAssetSnapshot {
  id: string;
  name: string;
  size: number;
  role: PublicationAssetRole;
  order: number;
  mediaType: string | null;
  hash: string | null;
  downloadedAt: string | null;
  sourceAssetId: string | null;
  sourceOrigin: string | null;
  localRelativePath: string | null;
}

export interface PublicationSnapshot {
  requestId: string;
  sourcePublicationId?: string;
  publication: Readonly<PublicationStateSnapshot>;
  contentRevision: Readonly<ContentRevision>;
  contentForm: SupportedPublishContentForm;
  tags: readonly string[];
  submissionMode: PublicationSubmissionMode;
  submissionEvidence?: SubmissionEvidence;
  lastObservationSequence?: number;
  retained: boolean;
  assets: readonly PublicationAssetSnapshot[];
  rulesVersion: string;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string;
}

export interface PublicationStartInput {
  requestId: string;
  sourcePublicationId?: string;
  publicationId: string;
  contentRevisionId: string;
  platformId: string;
  accountId: string;
  contentForm: SupportedPublishContentForm;
  title: string;
  body: string;
  tags?: readonly string[];
  submissionMode: SubmissionMode;
  assets: readonly PublicationAssetSnapshot[];
  rulesVersion: string;
  occurredAt: string;
  qualification: {
    capability: Pick<
      PlatformPublishFormCapability,
      "constraints" | "submissionModes"
    >;
    body?: string;
    platformName?: string;
  };
}

export interface PublicationQualificationInput {
  contentForm: SupportedPublishContentForm;
  submissionMode: SubmissionMode;
  title: string;
  body: string;
  assetCount: number;
  capability: Pick<
    PlatformPublishFormCapability,
    "constraints" | "submissionModes"
  >;
  platformName?: string;
}

export class PublicationQualification {
  static assertSatisfied(input: PublicationQualificationInput): void {
    if (
      !input ||
      !supportedPublishContentForms.includes(input.contentForm) ||
      !submissionModes.includes(input.submissionMode) ||
      typeof input.title !== "string" ||
      typeof input.body !== "string" ||
      !Number.isSafeInteger(input.assetCount) ||
      input.assetCount < 0 ||
      !input.capability ||
      typeof input.capability.constraints !== "object" ||
      input.capability.constraints === null ||
      !Array.isArray(input.capability.submissionModes)
    ) {
      throw new TypeError("Publication qualification input is invalid");
    }
    const platform = input.platformName ?? "Platform";
    if (!input.capability.submissionModes.includes(input.submissionMode)) {
      throw new TypeError(
        `${platform}暂不支持${input.submissionMode === "automatic" ? "自动提交" : "人工确认"}`,
      );
    }
    if (
      input.capability.constraints.titleMaxLength !== undefined &&
      input.title.length > input.capability.constraints.titleMaxLength
    ) {
      throw new TypeError(
        `${platform}标题最多 ${input.capability.constraints.titleMaxLength} 字`,
      );
    }
    if (
      input.capability.constraints.bodyMaxLength !== undefined &&
      input.body.length > input.capability.constraints.bodyMaxLength
    ) {
      throw new TypeError(
        `${platform}正文最多 ${input.capability.constraints.bodyMaxLength} 字`,
      );
    }
    if (
      input.capability.constraints.mediaMaxCount !== undefined &&
      input.assetCount > input.capability.constraints.mediaMaxCount
    ) {
      throw new TypeError(
        `${platform}最多支持 ${input.capability.constraints.mediaMaxCount} 个素材`,
      );
    }
  }
}

export type PublicationObservation =
  | {
      kind: "submission_attempted";
      source: "application_commit" | "page_request";
      message: string;
    }
  | { kind: "verification_required"; message: string }
  | { kind: "verifying"; message: string }
  | { kind: "published"; contentId: string | null; contentUrl: string | null }
  | { kind: "failed"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "cancelled"; message: string };

export class InvalidPublicationSnapshotError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublicationSnapshotError";
  }
}

export class Publication {
  private snapshot: PublicationSnapshot;

  private constructor(snapshot: PublicationSnapshot) {
    assertPublicationSnapshot(snapshot);
    this.snapshot = clone(snapshot);
  }

  static start(input: PublicationStartInput): Publication {
    PublicationQualification.assertSatisfied({
      contentForm: input.contentForm,
      submissionMode: input.submissionMode,
      title: input.title,
      body: input.qualification.body ?? input.body,
      assetCount: input.assets.length,
      capability: input.qualification.capability,
      platformName: input.qualification.platformName,
    });
    const contentRevision = createContentRevision({
      id: input.contentRevisionId,
      contentItemId: input.publicationId,
      revision: 1,
      title: input.title,
      body: input.body,
      assetIds: input.assets.map(({ id }) => id),
      createdAt: input.occurredAt,
    });
    const draft = createPublication({
      id: input.publicationId,
      platformId: input.platformId,
      accountId: input.accountId,
      contentRevisionId: input.contentRevisionId,
    });
    const validated = transitionPublication(
      draft,
      "validated",
      input.occurredAt,
    );
    const preparing = transitionPublication(
      validated,
      "preparing",
      input.occurredAt,
    );
    return new Publication({
      requestId: input.requestId,
      ...(input.sourcePublicationId
        ? { sourcePublicationId: input.sourcePublicationId }
        : {}),
      publication: preparing,
      contentRevision,
      contentForm: input.contentForm,
      tags: [...(input.tags ?? [])],
      submissionMode: input.submissionMode,
      submissionEvidence: "none",
      lastObservationSequence: 0,
      retained: false,
      assets: input.assets,
      rulesVersion: input.rulesVersion,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    });
  }

  static rehydrate(snapshot: PublicationSnapshot): Publication {
    return new Publication(snapshot);
  }

  toSnapshot(): PublicationSnapshot {
    return clone(this.snapshot);
  }

  setRetained(retained: boolean, occurredAt: string): PublicationSnapshot {
    if (typeof retained !== "boolean") {
      throw new TypeError("Publication retention flag must be boolean");
    }
    this.replace({ ...this.snapshot, retained }, occurredAt);
    return this.toSnapshot();
  }

  canBeRemovedFromArchive(hasActiveTask = false): boolean {
    return (
      !hasActiveTask &&
      archiveRemovableStates.includes(this.snapshot.publication.state)
    );
  }

  canBeAutomaticallyCleanedFromArchive(hasActiveTask = false): boolean {
    return (
      !this.snapshot.retained && this.canBeRemovedFromArchive(hasActiveTask)
    );
  }

  awaitConfirmation(occurredAt: string): PublicationSnapshot {
    return this.transition("awaiting_confirmation", occurredAt);
  }

  beginSubmission(occurredAt: string): PublicationSnapshot {
    return this.transition("submitting", occurredAt);
  }

  failPreparation(message: string, occurredAt: string): PublicationSnapshot {
    return this.transition("failed", occurredAt, message);
  }

  markSubmissionUncertain(
    message: string,
    occurredAt: string,
  ): PublicationSnapshot {
    if (this.snapshot.publication.state === "uncertain")
      return this.toSnapshot();
    return this.transition("uncertain", occurredAt, message);
  }

  recordObservation(
    result: PublicationObservation,
    occurredAt: string,
    sequence?: number,
    expectedIdentity?: { accountId: string; platformId: string },
  ): PublicationSnapshot {
    if (
      sequence !== undefined &&
      (!Number.isSafeInteger(sequence) || sequence < 0)
    ) {
      throw new TypeError("Publication observation sequence is invalid");
    }
    const current = this.snapshot;
    if (
      expectedIdentity &&
      (current.publication.accountId !== expectedIdentity.accountId ||
        current.publication.platformId !== expectedIdentity.platformId)
    ) {
      throw new Error("Observation reference mismatch");
    }
    const currentSequence = current.lastObservationSequence ?? 0;
    if (sequence !== undefined && sequence <= currentSequence) {
      return this.toSnapshot();
    }
    if (
      (result.kind === "published" &&
        current.publication.state === "published") ||
      (result.kind === "failed" && current.publication.state === "failed") ||
      (result.kind === "uncertain" && current.publication.state === "uncertain")
    ) {
      if (sequence !== undefined) {
        this.replace(
          { ...current, lastObservationSequence: sequence },
          occurredAt,
        );
      }
      return this.toSnapshot();
    }

    const evidence = promoteEvidence(
      current.submissionEvidence ?? "legacy_unknown",
      evidenceFor(result),
    );
    let next: PublicationSnapshot = {
      ...current,
      submissionEvidence: evidence,
      lastObservationSequence: sequence ?? currentSequence,
    };

    if (result.kind === "submission_attempted") {
      if (
        next.publication.state === "preparing" ||
        next.publication.state === "awaiting_confirmation"
      ) {
        next = advanceSnapshot(next, "submitting", occurredAt, result.message);
      } else {
        next = { ...next, lastMessage: result.message };
      }
      this.replace(next, occurredAt);
      return this.toSnapshot();
    }
    if (result.kind === "verification_required") {
      this.replace({ ...next, lastMessage: result.message }, occurredAt);
      return this.toSnapshot();
    }
    if (result.kind === "verifying") {
      if (next.publication.state === "verifying") {
        this.replace({ ...next, lastMessage: result.message }, occurredAt);
        return this.toSnapshot();
      }
      if (
        next.publication.state === "preparing" ||
        next.publication.state === "awaiting_confirmation"
      ) {
        next = advanceSnapshot(next, "submitting", occurredAt);
      }
      this.replace(
        advanceSnapshot(next, "verifying", occurredAt, result.message),
        occurredAt,
      );
      return this.toSnapshot();
    }
    if (result.kind === "cancelled") {
      if (evidence === "none") {
        this.replace(
          advanceSnapshot(next, "cancelled", occurredAt, result.message),
          occurredAt,
        );
        return this.toSnapshot();
      }
      if (next.publication.state === "preparing") {
        next = advanceSnapshot(next, "submitting", occurredAt);
      }
      this.replace(
        advanceSnapshot(
          next,
          "uncertain",
          occurredAt,
          "观察结束前已存在提交证据，请先在平台核实",
        ),
        occurredAt,
      );
      return this.toSnapshot();
    }
    if (result.kind === "failed" || result.kind === "uncertain") {
      if (
        result.kind === "uncertain" &&
        next.publication.state === "preparing"
      ) {
        next = advanceSnapshot(next, "submitting", occurredAt);
      }
      this.replace(
        advanceSnapshot(next, result.kind, occurredAt, result.message),
        occurredAt,
      );
      return this.toSnapshot();
    }

    if (
      next.publication.state === "preparing" ||
      next.publication.state === "awaiting_confirmation"
    ) {
      next = advanceSnapshot(next, "submitting", occurredAt);
    }
    if (next.publication.state === "submitting") {
      next = advanceSnapshot(next, "verifying", occurredAt);
    }
    const published = transitionPublication(
      next.publication,
      "published",
      occurredAt,
    );
    this.replace(
      {
        ...next,
        publication: {
          ...published,
          ...(result.contentId === null
            ? {}
            : { platformContentId: result.contentId }),
          ...(result.contentUrl === null
            ? {}
            : { platformContentUrl: result.contentUrl }),
        },
        lastMessage: "发布成功",
      },
      occurredAt,
    );
    return this.toSnapshot();
  }

  recoverInterrupted(occurredAt: string): PublicationSnapshot | null {
    const state = this.snapshot.publication.state;
    if (state === "preparing") {
      if (this.evidence() === "none") {
        return this.transition(
          "failed",
          occurredAt,
          "应用在草稿准备完成前退出",
        );
      }
      let next = advanceSnapshot(this.snapshot, "submitting", occurredAt);
      next = advanceSnapshot(
        next,
        "uncertain",
        occurredAt,
        "应用重启后无法排除已经提交，请先在平台核实",
      );
      this.replace(next, occurredAt);
      return this.toSnapshot();
    }
    if (!recoverableActiveStates.includes(state)) return null;
    if (
      this.evidence() === "none" &&
      (state === "awaiting_confirmation" || state === "submitting")
    ) {
      return this.transition(
        "cancelled",
        occurredAt,
        "应用退出前没有观察到提交尝试",
      );
    }
    return this.transition(
      "uncertain",
      occurredAt,
      "应用重启后无法恢复发布结果监听，请先在平台核实",
    );
  }

  private evidence(): SubmissionEvidence {
    return this.snapshot.submissionEvidence ?? "legacy_unknown";
  }

  private transition(
    state: PublicationState,
    occurredAt: string,
    message?: string,
  ): PublicationSnapshot {
    this.replace(
      {
        ...this.snapshot,
        publication: transitionPublication(
          this.snapshot.publication,
          state,
          occurredAt,
          message,
        ),
        ...(message === undefined ? {} : { lastMessage: message }),
      },
      occurredAt,
    );
    return this.toSnapshot();
  }

  private replace(snapshot: PublicationSnapshot, occurredAt: string): void {
    assertTimestamp(occurredAt, "Publication update time");
    if (Date.parse(occurredAt) < Date.parse(this.snapshot.updatedAt)) {
      throw new TypeError("Publication update time cannot move backwards");
    }
    const candidate = { ...snapshot, updatedAt: occurredAt };
    assertPublicationSnapshot(candidate);
    if (Date.parse(candidate.updatedAt) < Date.parse(this.snapshot.updatedAt)) {
      throw new TypeError("Publication update time cannot move backwards");
    }
    this.snapshot = candidate;
  }
}

export function assertPublicationSnapshot(
  snapshot: PublicationSnapshot,
): PublicationSnapshot {
  try {
    if (!snapshot || typeof snapshot !== "object") {
      throw new TypeError("Publication snapshot must be an object");
    }
    for (const [name, value] of [
      ["request ID", snapshot.requestId],
      ["rules version", snapshot.rulesVersion],
      ["created time", snapshot.createdAt],
      ["updated time", snapshot.updatedAt],
    ] as const) {
      assertNonEmptyString(value, `Publication ${name}`);
    }
    if (
      snapshot.sourcePublicationId !== undefined &&
      (typeof snapshot.sourcePublicationId !== "string" ||
        !snapshot.sourcePublicationId.trim())
    ) {
      throw new TypeError("Publication source ID is invalid");
    }
    assertTimestamp(snapshot.createdAt, "Publication creation time");
    assertTimestamp(snapshot.updatedAt, "Publication update time");
    if (Date.parse(snapshot.updatedAt) < Date.parse(snapshot.createdAt)) {
      throw new TypeError("Publication update time cannot precede creation");
    }
    assertPublication(snapshot.publication);
    assertContentRevision(snapshot.contentRevision);
    if (
      Date.parse(snapshot.contentRevision.createdAt) >
      Date.parse(snapshot.updatedAt)
    ) {
      throw new TypeError(
        "Publication content revision cannot be after snapshot update",
      );
    }
    if (!supportedPublishContentForms.includes(snapshot.contentForm)) {
      throw new TypeError("Publication content form is invalid");
    }
    if (!publicationSubmissionModes.includes(snapshot.submissionMode)) {
      throw new TypeError("Publication submission mode is invalid");
    }
    if (
      snapshot.publication.contentRevisionId !== snapshot.contentRevision.id
    ) {
      throw new TypeError("Publication content revision reference is invalid");
    }
    if (snapshot.contentRevision.contentItemId !== snapshot.publication.id) {
      throw new TypeError("Publication content item reference is invalid");
    }
    if (!publicationStates.includes(snapshot.publication.state)) {
      throw new TypeError("Publication state is invalid");
    }
    if (!Array.isArray(snapshot.publication.transitions)) {
      throw new TypeError("Publication transitions must be an array");
    }
    assertTransitionHistory(snapshot.publication, snapshot.updatedAt);
    if (!Array.isArray(snapshot.assets) || !Array.isArray(snapshot.tags)) {
      throw new TypeError("Publication collections are invalid");
    }
    if (
      !snapshot.tags.every(
        (tag) => typeof tag === "string" && tag.length <= 200,
      )
    ) {
      throw new TypeError("Publication tags are invalid");
    }
    assertAssets(snapshot.assets, snapshot.contentRevision.assetIds);
    if (
      !Number.isSafeInteger(snapshot.lastObservationSequence ?? 0) ||
      (snapshot.lastObservationSequence ?? 0) < 0
    ) {
      throw new TypeError("Publication observation sequence is invalid");
    }
    if (typeof snapshot.retained !== "boolean") {
      throw new TypeError("Publication retention flag is invalid");
    }
    if (
      snapshot.lastMessage !== undefined &&
      typeof snapshot.lastMessage !== "string"
    ) {
      throw new TypeError("Publication last message is invalid");
    }
    if (
      snapshot.submissionEvidence !== undefined &&
      !submissionEvidences.includes(snapshot.submissionEvidence)
    ) {
      throw new TypeError("Publication submission evidence is invalid");
    }
  } catch (error) {
    if (error instanceof InvalidPublicationSnapshotError) throw error;
    throw new InvalidPublicationSnapshotError(
      error instanceof Error ? error.message : "Invalid publication snapshot",
    );
  }
  return snapshot;
}

function assertPublication(publication: PublicationStateSnapshot): void {
  for (const [name, value] of [
    ["ID", publication.id],
    ["platform ID", publication.platformId],
    ["account ID", publication.accountId],
    ["content revision ID", publication.contentRevisionId],
  ] as const) {
    assertNonEmptyString(value, `Publication ${name}`);
  }
  if (
    (publication.platformContentId !== undefined &&
      (typeof publication.platformContentId !== "string" ||
        publication.platformContentId.length === 0)) ||
    (publication.platformContentUrl !== undefined &&
      (typeof publication.platformContentUrl !== "string" ||
        publication.platformContentUrl.length === 0))
  ) {
    throw new TypeError("Publication remote identity is invalid");
  }
}

function assertContentRevision(revision: ContentRevision): void {
  assertNonEmptyString(revision.id, "Content revision ID");
  assertNonEmptyString(revision.contentItemId, "Content item ID");
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 1) {
    throw new TypeError("Content revision number is invalid");
  }
  if (typeof revision.body !== "string") {
    throw new TypeError("Content revision body is invalid");
  }
  if (revision.title !== undefined && typeof revision.title !== "string") {
    throw new TypeError("Content revision title is invalid");
  }
  assertTimestamp(revision.createdAt, "Content revision creation time");
  if (!Array.isArray(revision.assetIds)) {
    throw new TypeError("Content revision asset references are invalid");
  }
  if (
    new Set(revision.assetIds).size !== revision.assetIds.length ||
    !revision.assetIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new TypeError("Content revision asset references are invalid");
  }
}

function assertAssets(
  assets: readonly PublicationAssetSnapshot[],
  assetIds: readonly string[],
): void {
  if (assets.length !== assetIds.length) {
    throw new TypeError("Publication asset count does not match content");
  }
  const ids = assets.map((asset) => asset.id);
  if (
    ids.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id !== assetIds[index])
  ) {
    throw new TypeError("Publication asset references are inconsistent");
  }
  assets.forEach((asset, index) => {
    if (!Number.isSafeInteger(asset.order) || asset.order !== index) {
      throw new TypeError("Publication asset order is invalid");
    }
    if (typeof asset.name !== "string" || asset.name.length === 0) {
      throw new TypeError("Publication asset name is invalid");
    }
    if (!Number.isFinite(asset.size) || asset.size < 0) {
      throw new TypeError("Publication asset size is invalid");
    }
    if (!publicationAssetRoles.includes(asset.role)) {
      throw new TypeError("Publication asset role is invalid");
    }
    for (const [name, value] of [
      ["media type", asset.mediaType],
      ["hash", asset.hash],
      ["source asset ID", asset.sourceAssetId],
      ["source origin", asset.sourceOrigin],
      ["local path", asset.localRelativePath],
    ] as const) {
      if (value !== null && typeof value !== "string") {
        throw new TypeError(`Publication asset ${name} is invalid`);
      }
    }
    if (asset.downloadedAt !== null) {
      assertTimestamp(asset.downloadedAt, "Publication asset download time");
    }
  });
}

function assertTransitionHistory(
  publication: PublicationStateSnapshot,
  updatedAt: string,
): void {
  const transitions = publication.transitions;
  if (transitions.length === 0) {
    if (publication.state !== "draft") {
      throw new TypeError("Publication transition history is incomplete");
    }
    return;
  }
  let previous = transitions[0]!.from;
  for (const transition of transitions) {
    if (
      !publicationStates.includes(transition.from) ||
      !publicationStates.includes(transition.to)
    ) {
      throw new TypeError("Publication transition state is invalid");
    }
    if (transition.from !== previous) {
      throw new TypeError("Publication transition history is not continuous");
    }
    assertTimestamp(transition.occurredAt, "Publication transition time");
    if (
      transition.reason !== undefined &&
      typeof transition.reason !== "string"
    ) {
      throw new TypeError("Publication transition reason is invalid");
    }
    if (Date.parse(transition.occurredAt) > Date.parse(updatedAt)) {
      throw new TypeError(
        "Publication transition cannot be after snapshot update",
      );
    }
    if (!allowedTransitions[transition.from].includes(transition.to)) {
      throw new TypeError("Publication transition is not allowed");
    }
    previous = transition.to;
  }
  if (previous !== publication.state) {
    throw new TypeError("Publication state does not match transition history");
  }
  for (let index = 1; index < transitions.length; index += 1) {
    if (
      Date.parse(transitions[index]!.occurredAt) <
      Date.parse(transitions[index - 1]!.occurredAt)
    ) {
      throw new TypeError("Publication transition times are not ordered");
    }
  }
}

const recoverableActiveStates: readonly PublicationState[] = [
  "awaiting_confirmation",
  "submitting",
  "verifying",
];

const evidenceRanks: Readonly<
  Record<Exclude<SubmissionEvidence, "legacy_unknown">, number>
> = {
  none: 0,
  submission_attempted: 1,
  verification_observed: 2,
  accepted: 3,
};

function evidenceFor(
  result: PublicationObservation,
): Exclude<SubmissionEvidence, "legacy_unknown"> {
  switch (result.kind) {
    case "submission_attempted":
      return "submission_attempted";
    case "verification_required":
      return "verification_observed";
    case "verifying":
    case "published":
    case "failed":
      return "accepted";
    case "uncertain":
    case "cancelled":
      return "none";
  }
}

function promoteEvidence(
  current: SubmissionEvidence,
  next: Exclude<SubmissionEvidence, "legacy_unknown">,
): SubmissionEvidence {
  if (current === "legacy_unknown") return next === "none" ? current : next;
  return evidenceRanks[next] > evidenceRanks[current] ? next : current;
}

function advanceSnapshot(
  snapshot: PublicationSnapshot,
  state: PublicationState,
  occurredAt: string,
  message?: string,
): PublicationSnapshot {
  return {
    ...snapshot,
    publication: transitionPublication(
      snapshot.publication,
      state,
      occurredAt,
      message,
    ),
    ...(message === undefined ? {} : { lastMessage: message }),
  };
}

function assertNonEmptyString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a timestamp`);
  }
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        clone(entry),
      ]),
    ) as T;
  }
  return value;
}
