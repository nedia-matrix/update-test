import type {
  PlatformContentSnapshot,
  PlatformContentSyncRun,
} from "@nedia-matrix/platform-content";

const MAX_PLATFORM_LENGTH = 128;
const MAX_EXTERNAL_ACCOUNT_ID_LENGTH = 128;
const MAX_EXTERNAL_CONTENT_ID_LENGTH = 512;
const MAX_EXTERNAL_CONTENT_IDS = 100;
const forbiddenIdentityFields = [
  "accountId",
  "runtimeAccountId",
  "webAccountId",
  "platformAccountId",
] as const;

export interface RuntimePlatformAccountTarget {
  readonly platform: string;
  readonly externalAccountId: string;
}

export interface RuntimePlatformContentQuery {
  readonly target: RuntimePlatformAccountTarget;
  readonly externalContentIds: readonly string[];
}

export function parseRuntimePlatformContentSyncRequest(
  value: Record<string, unknown>,
): RuntimePlatformAccountTarget {
  rejectInternalIdentityFields(value);
  return parseTarget(value.target);
}

export function parseRuntimePlatformContentQuery(
  value: Record<string, unknown>,
): RuntimePlatformContentQuery {
  rejectInternalIdentityFields(value);
  const target = parseTarget(value.target);
  if (
    !Array.isArray(value.externalContentIds) ||
    value.externalContentIds.length === 0 ||
    value.externalContentIds.length > MAX_EXTERNAL_CONTENT_IDS
  ) {
    throw new TypeError(
      `externalContentIds must contain 1 to ${MAX_EXTERNAL_CONTENT_IDS} items`,
    );
  }
  const externalContentIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.externalContentIds) {
    const externalContentId = requireBoundedString(
      candidate,
      "externalContentIds[]",
      MAX_EXTERNAL_CONTENT_ID_LENGTH,
    );
    if (!seen.has(externalContentId)) {
      seen.add(externalContentId);
      externalContentIds.push(externalContentId);
    }
  }
  return { target, externalContentIds };
}

export function runtimePlatformContentSyncResult(
  target: RuntimePlatformAccountTarget,
  run: PlatformContentSyncRun,
) {
  return {
    target,
    run: {
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      pagesRead: run.pagesRead,
      itemsRead: run.itemsRead,
      remoteTotal: run.remoteTotal,
      diagnostics: [...run.diagnostics],
    },
  };
}

export function runtimePlatformContentQueryResult(
  query: RuntimePlatformContentQuery,
  result: {
    contents: readonly PlatformContentSnapshot[];
    latestRun: PlatformContentSyncRun | undefined;
  },
) {
  const byExternalContentId = new Map(
    result.contents.map((content) => [content.externalContentId, content]),
  );
  return {
    target: query.target,
    latestSync: result.latestRun
      ? {
          status: result.latestRun.status,
          startedAt: result.latestRun.startedAt,
          completedAt: result.latestRun.completedAt,
          pagesRead: result.latestRun.pagesRead,
          itemsRead: result.latestRun.itemsRead,
          remoteTotal: result.latestRun.remoteTotal,
        }
      : null,
    results: query.externalContentIds.map((externalContentId) => {
      const content = byExternalContentId.get(externalContentId);
      return content
        ? {
            externalContentId,
            status: "found" as const,
            snapshot: {
              contentUrl: content.contentUrl,
              contentType: content.contentType,
              title: content.title,
              description: content.description,
              coverUrl: content.coverUrl,
              publishedAt: content.publishedAt,
              platformStatus: content.platformStatus,
              metrics: { ...content.metrics },
              contentObservedAt: content.contentObservedAt,
              metricsObservedAt: content.metricsObservedAt,
            },
          }
        : {
            externalContentId,
            status: "not_observed" as const,
            snapshot: null,
          };
    }),
  };
}

function parseTarget(value: unknown): RuntimePlatformAccountTarget {
  const target = requireRecord(value, "target");
  rejectInternalIdentityFields(target);
  return {
    platform: requireBoundedString(
      target.platform,
      "target.platform",
      MAX_PLATFORM_LENGTH,
    ),
    externalAccountId: requireBoundedString(
      target.externalAccountId,
      "target.externalAccountId",
      MAX_EXTERNAL_ACCOUNT_ID_LENGTH,
    ),
  };
}

function rejectInternalIdentityFields(value: Record<string, unknown>): void {
  for (const field of forbiddenIdentityFields) {
    if (field in value) {
      throw new TypeError(`${field} is not accepted by the Local Runtime`);
    }
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${maxLength} characters`,
    );
  }
  return value;
}
