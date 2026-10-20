import type { PublicationSnapshot } from "@nedia-matrix/publishing";
import {
  publicationAssetRoles,
  publicationStates,
  publicationSubmissionModes,
  submissionEvidences,
} from "@nedia-matrix/publishing";
import type { PublicationState } from "@nedia-matrix/publishing";
export const publicationStoreSchemaVersion = 5;

function normalizePublicationState(value: unknown): PublicationState | null {
  if (value === "publishing") return "submitting";
  return publicationStates.find((state) => state === value) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAsset(
  value: Record<string, unknown>,
  contentForm: PublicationSnapshot["contentForm"],
  order: number,
): PublicationSnapshot["assets"][number] | null {
  const role = publicationAssetRoles.find(
    (candidate) => candidate === value.role,
  );
  if (
    (value.role !== undefined && role === undefined) ||
    (value.order !== undefined && typeof value.order !== "number")
  ) {
    return null;
  }
  for (const key of [
    "mediaType",
    "hash",
    "downloadedAt",
    "sourceAssetId",
    "sourceOrigin",
    "localRelativePath",
  ] as const) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      typeof value[key] !== "string"
    ) {
      return null;
    }
  }
  return {
    id: value.id as string,
    name: value.name as string,
    size: value.size as number,
    role: role ?? (contentForm === "video" ? "video" : "image"),
    order: typeof value.order === "number" ? value.order : order,
    mediaType: typeof value.mediaType === "string" ? value.mediaType : null,
    hash: typeof value.hash === "string" ? value.hash : null,
    downloadedAt:
      typeof value.downloadedAt === "string" ? value.downloadedAt : null,
    sourceAssetId:
      typeof value.sourceAssetId === "string" ? value.sourceAssetId : null,
    sourceOrigin:
      typeof value.sourceOrigin === "string" ? value.sourceOrigin : null,
    localRelativePath:
      typeof value.localRelativePath === "string"
        ? value.localRelativePath
        : null,
  };
}

function parsePublicationSnapshot(value: unknown): PublicationSnapshot | null {
  if (!isRecord(value) || !isRecord(value.publication)) return null;
  const publication = value.publication;
  const contentRevision = value.contentRevision;
  const transitions = publication.transitions;
  const assets = value.assets;
  if (
    typeof publication.id !== "string" ||
    typeof publication.platformId !== "string" ||
    typeof publication.accountId !== "string" ||
    typeof publication.contentRevisionId !== "string" ||
    (publication.platformContentId !== undefined &&
      typeof publication.platformContentId !== "string") ||
    (publication.platformContentUrl !== undefined &&
      typeof publication.platformContentUrl !== "string") ||
    normalizePublicationState(publication.state) === null ||
    !Array.isArray(transitions) ||
    !transitions.every(
      (transition) =>
        isRecord(transition) &&
        normalizePublicationState(transition.from) !== null &&
        normalizePublicationState(transition.to) !== null &&
        typeof transition.occurredAt === "string" &&
        (transition.reason === undefined ||
          typeof transition.reason === "string"),
    ) ||
    !isRecord(contentRevision) ||
    typeof contentRevision.id !== "string" ||
    typeof contentRevision.contentItemId !== "string" ||
    typeof contentRevision.revision !== "number" ||
    (contentRevision.title !== undefined &&
      typeof contentRevision.title !== "string") ||
    typeof contentRevision.body !== "string" ||
    !Array.isArray(contentRevision.assetIds) ||
    !contentRevision.assetIds.every((id) => typeof id === "string") ||
    typeof contentRevision.createdAt !== "string" ||
    !Array.isArray(assets) ||
    !assets.every(
      (asset) =>
        isRecord(asset) &&
        typeof asset.id === "string" &&
        typeof asset.name === "string" &&
        typeof asset.size === "number",
    ) ||
    (value.contentForm !== "video" && value.contentForm !== "imageText") ||
    typeof value.rulesVersion !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.lastMessage !== undefined && typeof value.lastMessage !== "string")
  ) {
    return null;
  }
  if (
    value.pluginSource !== undefined &&
    (!isRecord(value.pluginSource) ||
      typeof value.pluginSource.pluginId !== "string" ||
      typeof value.pluginSource.pluginVersion !== "string" ||
      typeof value.pluginSource.packageDigest !== "string")
  )
    return null;
  if (
    value.platformDisplay !== undefined &&
    (!isRecord(value.platformDisplay) ||
      typeof value.platformDisplay.name !== "string" ||
      !Array.isArray(value.platformDisplay.allowedHostSuffixes) ||
      !value.platformDisplay.allowedHostSuffixes.every(
        (host) => typeof host === "string",
      ))
  )
    return null;
  const contentForm = value.contentForm as PublicationSnapshot["contentForm"];
  const tags = value.tags === undefined ? [] : value.tags;
  const submissionMode =
    value.submissionMode === undefined
      ? "legacy_unknown"
      : publicationSubmissionModes.find(
          (candidate) => candidate === value.submissionMode,
        );
  const submissionEvidence =
    value.submissionEvidence === undefined
      ? "legacy_unknown"
      : submissionEvidences.find(
          (candidate) => candidate === value.submissionEvidence,
        );
  const lastObservationSequence =
    value.lastObservationSequence === undefined
      ? 0
      : value.lastObservationSequence;
  const retained = value.retained === undefined ? false : value.retained;
  const normalizedAssets = assets.map((asset, order) =>
    normalizeAsset(asset as Record<string, unknown>, contentForm, order),
  );
  if (
    !Array.isArray(tags) ||
    !tags.every((tag) => typeof tag === "string") ||
    submissionMode === undefined ||
    submissionEvidence === undefined ||
    !Number.isSafeInteger(lastObservationSequence) ||
    Number(lastObservationSequence) < 0 ||
    typeof retained !== "boolean" ||
    normalizedAssets.some((asset) => asset === null)
  ) {
    return null;
  }
  return {
    ...(value as unknown as PublicationSnapshot),
    requestId:
      typeof value.requestId === "string"
        ? value.requestId
        : `legacy:${String(publication.id)}`,
    publication: {
      ...(publication as unknown as PublicationSnapshot["publication"]),
      state: normalizePublicationState(publication.state)!,
      transitions: transitions.map((transition) => {
        const stored = transition as Record<string, unknown>;
        return {
          from: normalizePublicationState(stored.from)!,
          to: normalizePublicationState(stored.to)!,
          occurredAt: stored.occurredAt as string,
          ...(typeof stored.reason === "string"
            ? { reason: stored.reason }
            : {}),
        };
      }),
    },
    tags,
    submissionMode,
    submissionEvidence,
    lastObservationSequence: Number(lastObservationSequence),
    retained,
    assets: normalizedAssets as PublicationSnapshot["assets"],
  };
}

export function parseStoredPublications(value: unknown): PublicationSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parsePublicationSnapshot)
    .filter((record): record is PublicationSnapshot => record !== null);
}

export function assertSupportedPublicationStoreVersion(value: unknown): void {
  if (
    value === undefined ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === publicationStoreSchemaVersion
  )
    return;
  throw new Error(
    `Unsupported publication store schema version: ${String(value)}`,
  );
}

export function mergeStoredPublication(
  value: unknown,
  record: PublicationSnapshot,
): unknown[] {
  const stored = Array.isArray(value) ? [...value] : [];
  const index = stored.findIndex(
    (candidate) =>
      parsePublicationSnapshot(candidate)?.publication.id ===
      record.publication.id,
  );
  if (index === -1) stored.push(record);
  else stored[index] = record;
  return stored;
}

export function removeStoredPublication(
  value: unknown,
  publicationId: string,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate) =>
      parsePublicationSnapshot(candidate)?.publication.id !== publicationId,
  );
}
