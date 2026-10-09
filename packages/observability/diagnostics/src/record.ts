export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface PendingDiagnosticRecord {
  readonly timestamp: string;
  readonly level: DiagnosticLevel;
  readonly sequence: number;
  readonly traceId: string;
  readonly eventId?: string;
  readonly executionId?: string;
  readonly operation: string;
  readonly component: string;
  readonly event: string;
  readonly platformId?: string;
  readonly accountId?: string;
  readonly requestId?: string;
  readonly publicationId?: string;
  readonly pageId?: string;
  readonly workflowId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly attachmentIds?: readonly string[];
}

export interface DiagnosticRecord extends PendingDiagnosticRecord {
  readonly schemaVersion: 2;
  readonly eventId: string;
}

export interface DiagnosticStore {
  report(record: PendingDiagnosticRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  findTraceForPublication(publicationId: string): Promise<string | null>;
  readTrace(
    traceId: string,
    limit?: number,
    afterSequence?: number,
  ): Promise<DiagnosticRecord[]>;
}
