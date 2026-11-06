import type { DiagnosticRecord } from "./record.js";
export type { DiagnosticRecord } from "./record.js";

export interface DiagnosticSource {
  id: string;
  label: string;
  path: string;
  kind: "directory" | "files" | "zip";
}
export interface DiagnosticFilter {
  text?: string;
  level?: string;
  operation?: string;
  component?: string;
  event?: string;
  platformId?: string;
  correlationId?: string;
  traceId?: string;
  from?: string;
  to?: string;
}
export interface DiagnosticQuery {
  filter?: DiagnosticFilter;
  offset?: number;
  limit?: number;
}
export interface DiagnosticQueryResult {
  records: DiagnosticRecord[];
  matched: number;
  scannedBytes: number;
  scannedFiles: number;
  issues: Record<string, number>;
  truncated: boolean;
  cancelled: boolean;
}
