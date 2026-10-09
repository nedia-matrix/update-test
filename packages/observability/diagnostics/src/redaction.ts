import type { DiagnosticRecord, PendingDiagnosticRecord } from "./record.js";

const MAX_MESSAGE_LENGTH = 2_048;
const MAX_ID_LENGTH = 256;
export const MAX_DIAGNOSTIC_RECORD_BYTES = 16 * 1_024;

const allowedDetailKeys = new Set([
  "appVersion",
  "architecture",
  "attempt",
  "assetCount",
  "assetIndex",
  "attemptedCandidates",
  "boundary",
  "browserChannel",
  "browserVersion",
  "byteSize",
  "capturedAt",
  "code",
  "complete",
  "count",
  "currentVersion",
  "debug",
  "decision",
  "diagnosticCount",
  "durationMs",
  "elementState",
  "error",
  "errorName",
  "evidenceId",
  "failedStage",
  "headless",
  "height",
  "implementationStatus",
  "info",
  "inputs",
  "itemsRead",
  "kind",
  "late",
  "latestVersion",
  "matchCount",
  "method",
  "message",
  "mimeType",
  "operatingSystem",
  "operatingSystemVersion",
  "outcome",
  "owner",
  "pageDefinitionId",
  "pagesRead",
  "phase",
  "purpose",
  "reason",
  "reasonCode",
  "relativeRef",
  "receivedBytes",
  "route",
  "remoteTotal",
  "retryable",
  "rulesVersion",
  "selectedCandidateIndex",
  "selectedCandidateKind",
  "source",
  "stage",
  "stateId",
  "status",
  "statusCode",
  "stepCount",
  "stepIndex",
  "stepKind",
  "summary",
  "taskId",
  "truncated",
  "url",
  "version",
  "warn",
  "width",
]);

const allowedNestedKeys = new Set([
  "attached",
  "attemptedCandidates",
  "count",
  "durationMs",
  "editable",
  "elementState",
  "enabled",
  "kind",
  "length",
  "matchCount",
  "outcome",
  "selectedCandidateIndex",
  "selectedCandidateKind",
  "visible",
]);

export function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-or-relative-url";
  }
}

export function sanitizeDiagnosticMessage(
  value: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string {
  const sanitized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /\b(cookie|authorization|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b1[3-9]\d{9}\b/g, "[phone]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"']+/g, "[path]")
    .replace(/\/(?:Users|home|var|tmp)\/[^\s"']+/g, "[path]");
  return sanitized.length <= maxLength
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeId(value: string): string {
  return sanitizeDiagnosticMessage(value, MAX_ID_LENGTH);
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key === "url") return sanitizeDiagnosticUrl(value);
    if (key === "message" || key === "reason")
      return sanitizeDiagnosticMessage(value);
    return sanitizeId(value);
  }
  if (depth >= 3 || !value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const output: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (!allowedNestedKeys.has(nestedKey) && key !== "inputs") continue;
    if (key === "inputs" && !/^[A-Za-z0-9._~-]{1,128}$/.test(nestedKey))
      continue;
    const cleaned = sanitizeValue(nestedKey, nestedValue, depth + 1);
    if (cleaned !== undefined) output[nestedKey] = cleaned;
  }
  return output;
}

function sanitizeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
  onUnknownKeys?: (keys: readonly string[]) => void,
) {
  if (!details) return undefined;
  const output: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (!allowedDetailKeys.has(key)) {
      unknownKeys.push(key);
      continue;
    }
    const cleaned = sanitizeValue(key, value, 0);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  if (unknownKeys.length) onUnknownKeys?.(unknownKeys.sort());
  return Object.keys(output).length > 0 ? output : undefined;
}

export function redactDiagnosticRecord(
  pending: PendingDiagnosticRecord,
  onUnknownDetailKeys?: (keys: readonly string[]) => void,
): DiagnosticRecord {
  const details = sanitizeDetails(pending.details, onUnknownDetailKeys);
  const record: DiagnosticRecord = {
    schemaVersion: 2,
    timestamp: new Date(pending.timestamp).toISOString(),
    level: pending.level,
    sequence: pending.sequence,
    traceId: sanitizeId(pending.traceId),
    eventId: sanitizeId(
      pending.eventId ?? `${pending.traceId}:${pending.sequence}`,
    ),
    operation: sanitizeId(pending.operation),
    component: sanitizeId(pending.component),
    event: sanitizeId(pending.event),
    ...(pending.executionId
      ? { executionId: sanitizeId(pending.executionId) }
      : {}),
    ...(pending.platformId
      ? { platformId: sanitizeId(pending.platformId) }
      : {}),
    ...(pending.accountId ? { accountId: sanitizeId(pending.accountId) } : {}),
    ...(pending.requestId ? { requestId: sanitizeId(pending.requestId) } : {}),
    ...(pending.publicationId
      ? { publicationId: sanitizeId(pending.publicationId) }
      : {}),
    ...(pending.pageId ? { pageId: sanitizeId(pending.pageId) } : {}),
    ...(pending.workflowId
      ? { workflowId: sanitizeId(pending.workflowId) }
      : {}),
    ...(pending.attachmentIds?.length
      ? { attachmentIds: pending.attachmentIds.map(sanitizeId) }
      : {}),
    ...(details ? { details } : {}),
  };
  return fitRecord(record);
}

function fitRecord(record: DiagnosticRecord): DiagnosticRecord {
  if (
    Buffer.byteLength(JSON.stringify(record), "utf8") <=
    MAX_DIAGNOSTIC_RECORD_BYTES
  )
    return record;
  const message = record.details?.message;
  const shortened = {
    ...record,
    details: {
      ...(record.details ?? {}),
      ...(typeof message === "string"
        ? { message: sanitizeDiagnosticMessage(message, 512) }
        : {}),
      truncated: true,
    },
  };
  if (
    Buffer.byteLength(JSON.stringify(shortened), "utf8") <=
    MAX_DIAGNOSTIC_RECORD_BYTES
  )
    return shortened;
  return { ...record, details: { truncated: true }, attachmentIds: undefined };
}
