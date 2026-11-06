import type { DiagnosticRecord } from "./record.js";

export function normalizeRecord(value: unknown): DiagnosticRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<DiagnosticRecord>;
  if (
    typeof record.traceId !== "string" ||
    typeof record.sequence !== "number" ||
    typeof record.timestamp !== "string" ||
    typeof record.level !== "string" ||
    typeof record.operation !== "string" ||
    typeof record.component !== "string" ||
    typeof record.event !== "string"
  ) {
    return null;
  }
  return {
    ...(record as DiagnosticRecord),
    schemaVersion: 2,
    eventId:
      typeof record.eventId === "string"
        ? record.eventId
        : `${record.traceId}:${record.sequence}`,
  };
}
