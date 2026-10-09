import type {
  SubmissionMode,
  SupportedPublishContentForm,
} from "@nedia-matrix/publishing";

export interface PlatformLoginEntrySummary {
  id: string;
  displayName: string;
  url: string;
}

export interface PlatformSummary {
  id: string;
  displayName: string;
  entryUrl: string;
  rulesVersion: string;
  implementationStatus:
    "route-only" | "reference-derived" | "fixture-tested" | "live-tested";
  loginEntries: PlatformLoginEntrySummary[];
  publishCapabilities: Array<{
    contentForm: SupportedPublishContentForm;
    submissionModes: SubmissionMode[];
    constraints: {
      titleMaxLength?: number;
      bodyMaxLength?: number;
      mediaMaxCount?: number;
    };
    tagPolicy?: {
      placement: "inline" | "new-lines";
      maxCount?: number;
    };
    descriptionComposition?: {
      parts: Array<"title" | "body">;
      separator: string;
    };
  }>;
}

export interface LocalRuntimeStatus {
  status: "running" | "stopped";
  version: string | null;
  host: "127.0.0.1";
  port: number | null;
}

export interface SetLocalRuntimeRunningRequest {
  running: boolean;
}

export type ApplicationUpdateCheckResult =
  | {
      status: "up-to-date";
      currentVersion: string;
    }
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
    };

export interface OpenApplicationUpdateDownloadRequest {
  version: string;
}

/** Main owns paths and URLs; the Renderer receives only presentation data. */
export interface ApplicationUpdateState {
  revision: number;
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "verifying" | "ready" | "failed";
  currentVersion: string;
  latestVersion?: string;
  taskId?: string;
  downloadAvailable: boolean;
  receivedBytes: number;
  totalBytes: number;
  message?: string;
  error?: { stage: "check" | "download"; retryable: boolean; message: string };
}

export interface FindDiagnosticTraceRequest {
  publicationId: string;
}

export interface DiagnosticTraceReference {
  traceId: string;
}

export interface ReadDiagnosticTraceRequest {
  traceId: string;
  limit?: number;
  afterSequence?: number;
}

export interface DiagnosticTraceRecord {
  schemaVersion: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  sequence: number;
  traceId: string;
  eventId: string;
  operation: string;
  component: string;
  event: string;
  details?: Readonly<Record<string, unknown>>;
  attachmentIds?: readonly string[];
}

export interface ReadDiagnosticAttachmentRequest {
  traceId: string;
  attachmentId: string;
}

export interface DiagnosticAttachment {
  id: string;
  traceId: string;
  eventId: string;
  kind: "screenshot";
  mimeType: "image/png";
  relativeRef: string;
  capturedAt: string;
  reasonCode: string;
  byteSize: number;
  width?: number;
  height?: number;
  dataBase64: string;
}

export interface ExportDiagnosticTraceRequest {
  traceId: string;
}

export interface ExportDiagnosticTraceResult {
  exported: boolean;
}
