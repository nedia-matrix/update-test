import type { TaskUseCases } from "./tasks.js";
import type {
  LocalRuntimeSettings,
  UpdateLocalRuntimeSettings,
  RuntimeAccountAccess,
} from "./runtime-access.js";
import type {
  PlatformPluginSummary,
  PlatformPluginChange,
  BundledPlatformPlugin,
} from "./plugins.js";
import type {
  AccountBrowserState,
  AccountBrowserSwitchStatus,
  BeginAccountBrowserSwitchRequest,
  AccountBrowserSwitchRequest,
} from "./account-browser-switch.js";
import type {
  FingerprintBrowserStatus,
  InstallFingerprintBrowserRequest,
  CancelFingerprintBrowserInstallRequest,
} from "./fingerprint-browser.js";
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
  PlatformContentSyncProgress,
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
  ApplicationTechnicalInformation,
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

import type { AccountBrowserRuntime } from "./account-browser-runtime.js";

export interface MatrixDesktopApi {
  tasks: {
    [K in keyof TaskUseCases]: (
      ...args: Parameters<TaskUseCases[K]>
    ) => Promise<ReturnType<TaskUseCases[K]>>;
  };
  onTasksChanged(listener: () => void): () => void;
  listPlugins(): Promise<PlatformPluginSummary[]>;
  listBundledPlugins(): Promise<BundledPlatformPlugin[]>;
  installBundledPlugin(id: string): Promise<PlatformPluginSummary[]>;
  installPlugin(): Promise<PlatformPluginSummary[]>;
  changePlugin(change: PlatformPluginChange): Promise<PlatformPluginSummary[]>;
  restartForPluginChanges(): Promise<void>;
  setAccountSettings(
    request: import("@nedia-matrix/account-management").SetAccountSettingsRequest,
  ): Promise<PlatformAccountView>;
  listAccountBrowserRuntimes(): Promise<AccountBrowserRuntime[]>;
  onAccountBrowserRuntimesChanged(
    listener: (runtimes: AccountBrowserRuntime[]) => void,
  ): () => void;
  getAccountBrowserState(
    request: PlatformAccountRequest,
  ): Promise<AccountBrowserState>;
  beginAccountBrowserSwitch(
    request: BeginAccountBrowserSwitchRequest,
  ): Promise<AccountBrowserSwitchStatus>;
  getAccountBrowserSwitch(
    request: AccountBrowserSwitchRequest,
  ): Promise<AccountBrowserSwitchStatus>;
  cancelAccountBrowserSwitch(
    request: AccountBrowserSwitchRequest,
  ): Promise<AccountBrowserSwitchStatus>;
  getFingerprintBrowserStatus(): Promise<FingerprintBrowserStatus>;
  installFingerprintBrowser(
    request?: InstallFingerprintBrowserRequest,
  ): Promise<FingerprintBrowserStatus>;
  cancelFingerprintBrowserInstall(
    request: CancelFingerprintBrowserInstallRequest,
  ): Promise<FingerprintBrowserStatus>;
  onFingerprintBrowserChanged(
    listener: (state: FingerprintBrowserStatus) => void,
  ): () => void;
  getPreferences(request?: GetPreferencesRequest): Promise<DesktopPreferences>;
  updatePreferences(
    request: UpdatePreferencesRequest,
  ): Promise<DesktopPreferences>;
  checkForApplicationUpdate(): Promise<ApplicationUpdateCheckResult>;
  getApplicationUpdateState(): Promise<ApplicationUpdateState>;
  onApplicationUpdateChanged(
    listener: (state: ApplicationUpdateState) => void,
  ): () => void;
  downloadApplicationUpdate(): Promise<void>;
  cancelApplicationUpdateDownload(): Promise<void>;
  installApplicationUpdate(): Promise<void>;
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
  onPlatformContentSyncProgress(
    listener: (progress: PlatformContentSyncProgress) => void,
  ): () => void;
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
  openPublicationAsset(request: {
    publicationId: string;
    assetIndex: number;
  }): Promise<void>;
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
  getLocalRuntimeSettings(): Promise<LocalRuntimeSettings>;
  updateLocalRuntimeSettings(
    request: UpdateLocalRuntimeSettings,
  ): Promise<LocalRuntimeSettings>;
  getRuntimeAccountAccess(accountId: string): Promise<RuntimeAccountAccess>;
  setRuntimeAccountAccess(
    request: RuntimeAccountAccess,
  ): Promise<RuntimeAccountAccess>;
  getLocalRuntimeStatus(): Promise<LocalRuntimeStatus>;
  setLocalRuntimeRunning(
    request: SetLocalRuntimeRunningRequest,
  ): Promise<LocalRuntimeStatus>;
  getTechnicalInformation(): Promise<ApplicationTechnicalInformation>;
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
