import type {
  DesktopPreferences,
  GetPreferencesRequest,
  UpdatePreferencesRequest,
} from "./preferences.js";
import type {
  CreatePlatformAccountRequest,
  DetectPlatformSessionResult,
  OpenPlatformAccountResult,
  OpenPlatformLoginRequest,
  OpenPlatformLoginResult,
  PlatformAccountRequest,
  PlatformAccountView,
} from "@nedia-matrix/account-management";
import type {
  PlatformContentSnapshot,
  PlatformContentSyncRun,
} from "@nedia-matrix/platform-content";
import type {
  OpenPublicationRequest,
  PreparePublishDraftRequest,
  PreparePublishDraftResult,
  PublicationTaskSummary,
  PublicationAttentionResolution,
  PublicationArchiveCleanupResult,
  PublicationQuery,
  PublicationQueryResult,
  RecreatedPublicationDraft,
  PublishResultUpdate,
  SelectPublishMediaRequest,
  SelectPublishMediaResult,
} from "@nedia-matrix/publishing";

import type {
  ApplicationUpdateCheckResult,
  ApplicationUpdateState,
  DiagnosticTraceRecord,
  DiagnosticAttachment,
  ExportDiagnosticTraceRequest,
  ExportDiagnosticTraceResult,
  DiagnosticTraceReference,
  FindDiagnosticTraceRequest,
  LocalRuntimeStatus,
  OpenApplicationUpdateDownloadRequest,
  PlatformSummary,
  SetLocalRuntimeRunningRequest,
  ReadDiagnosticTraceRequest,
  ReadDiagnosticAttachmentRequest,
} from "./contracts.js";

export interface MatrixDesktopApi {
  getPreferences(request?: GetPreferencesRequest): Promise<DesktopPreferences>;
  updatePreferences(
    request: UpdatePreferencesRequest,
  ): Promise<DesktopPreferences>;
  checkForApplicationUpdate(): Promise<ApplicationUpdateCheckResult>;
  getApplicationUpdateState(): Promise<ApplicationUpdateState>;
  onApplicationUpdateChanged(listener: (state: ApplicationUpdateState) => void): () => void;
  downloadApplicationUpdate(): Promise<void>;
  cancelApplicationUpdateDownload(): Promise<void>;
  showApplicationUpdateFile(): Promise<void>;
  openApplicationUpdateDownload(
    request: OpenApplicationUpdateDownloadRequest,
  ): Promise<void>;
  listPlatforms(): Promise<PlatformSummary[]>;
  listPlatformAccounts(): Promise<PlatformAccountView[]>;
  createPlatformAccount(
    request: CreatePlatformAccountRequest,
  ): Promise<PlatformAccountView>;
  openPlatformLogin(
    request: OpenPlatformLoginRequest,
  ): Promise<OpenPlatformLoginResult>;
  openPlatformAccount(
    request: PlatformAccountRequest,
  ): Promise<OpenPlatformAccountResult>;
  refreshPlatformAccount(
    request: PlatformAccountRequest,
  ): Promise<DetectPlatformSessionResult>;
  refreshPlatformAccountProfile(
    request: PlatformAccountRequest,
  ): Promise<PlatformAccountView>;
  removePlatformAccount(request: PlatformAccountRequest): Promise<void>;
  onPlatformAccountsChanged(listener: () => void): () => void;
  listPlatformContents(request: PlatformAccountRequest): Promise<{
    items: PlatformContentSnapshot[];
    latestRun: PlatformContentSyncRun | null;
  }>;
  refreshPlatformContents(
    request: PlatformAccountRequest,
  ): Promise<PlatformContentSyncRun>;
  openPlatformContent(request: {
    accountId: string;
    externalContentId: string;
  }): Promise<void>;
  selectPublishMedia(
    request: SelectPublishMediaRequest,
  ): Promise<SelectPublishMediaResult>;
  preparePublishDraft(
    request: PreparePublishDraftRequest,
  ): Promise<PreparePublishDraftResult>;
  queryPublications(request: PublicationQuery): Promise<PublicationQueryResult>;
  getPublicationTask(
    request: OpenPublicationRequest,
  ): Promise<PublicationTaskSummary | null>;
  getPublicationPlatformContent(request: OpenPublicationRequest): Promise<{
    content: PlatformContentSnapshot | null;
    latestRun: PlatformContentSyncRun | null;
    accountMissing: boolean;
  }>;
  recreatePublicationDraft(
    request: OpenPublicationRequest,
  ): Promise<RecreatedPublicationDraft>;
  resolvePublicationAttention(request: {
    publicationId: string;
    resolution: PublicationAttentionResolution;
    manualPlatformContentId?: string;
  }): Promise<PublicationTaskSummary>;
  selectPublicationContent(request: {
    publicationId: string;
    externalContentId: string;
  }): Promise<PublicationTaskSummary>;
  reopenPublicationAttention(request: {
    publicationId: string;
  }): Promise<PublicationTaskSummary>;
  removePublicationArchiveRecord(request: {
    publicationId: string;
  }): Promise<PublicationArchiveCleanupResult>;
  openPublicationReview(request: OpenPublicationRequest): Promise<void>;
  openPublication(request: OpenPublicationRequest): Promise<void>;
  onPublishResultUpdate(listener: (update: PublishResultUpdate) => void): void;
  getLocalRuntimeStatus(): Promise<LocalRuntimeStatus>;
  setLocalRuntimeRunning(
    request: SetLocalRuntimeRunningRequest,
  ): Promise<LocalRuntimeStatus>;
  openDiagnosticDirectory(): Promise<void>;
  findDiagnosticTrace(
    request: FindDiagnosticTraceRequest,
  ): Promise<DiagnosticTraceReference | null>;
  readDiagnosticTrace(
    request: ReadDiagnosticTraceRequest,
  ): Promise<DiagnosticTraceRecord[]>;
  readDiagnosticAttachment(
    request: ReadDiagnosticAttachmentRequest,
  ): Promise<DiagnosticAttachment | null>;
  exportDiagnosticTrace(
    request: ExportDiagnosticTraceRequest,
  ): Promise<ExportDiagnosticTraceResult>;
}
