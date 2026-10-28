import type { PlatformContentSyncProgress } from "@nedia-matrix/platform-content";
import type { FingerprintBrowserStatus } from "../bridge/fingerprint-browser.js";
import type { MatrixDesktopApi } from "../bridge/api.js";
import { ipcChannels } from "../bridge/channels.js";
import type {
  FindDiagnosticTraceRequest,
  ApplicationUpdateState,
  ExportDiagnosticTraceRequest,
  ReadDiagnosticTraceRequest,
  ReadDiagnosticAttachmentRequest,
  OpenApplicationUpdateDownloadRequest,
  SetLocalRuntimeRunningRequest,
} from "../bridge/contracts.js";
import type {
  CreatePlatformAccountRequest,
  OpenPlatformLoginRequest,
  PlatformAccountRequest,
} from "@nedia-matrix/account-management";
import type {
  OpenPublicationRequest,
  PublicationAttentionResolution,
  PublicationQuery,
  RecreatedPublicationDraft,
  PreparePublishDraftRequest,
  PublishResultUpdate,
  SelectPublishMediaRequest,
} from "@nedia-matrix/publishing";
import { contextBridge, ipcRenderer } from "electron";

import type { AccountBrowserRuntime } from "../bridge/account-browser-runtime.js";

const api: MatrixDesktopApi = {
  tasks: {
    clearHistory: (request) =>
      ipcRenderer.invoke(ipcChannels.clearTaskHistory, request),
    settings: () => ipcRenderer.invoke(ipcChannels.getTaskSettings),
    setRetentionDays: (value) =>
      ipcRenderer.invoke(ipcChannels.setTaskRetentionDays, value),
    summary: () => ipcRenderer.invoke(ipcChannels.getTaskSummary),
    acknowledgeAttention: (items) =>
      ipcRenderer.invoke(ipcChannels.acknowledgeTaskAttention, items),
    query: (request) =>
      ipcRenderer.invoke(ipcChannels.queryScheduledTasks, request),
    byRequest: (id) => ipcRenderer.invoke(ipcChannels.getTaskByRequest, id),
    get: (id) => ipcRenderer.invoke(ipcChannels.getScheduledTask, id),
    cancel: (id) => ipcRenderer.invoke(ipcChannels.cancelScheduledTask, id),
    enqueueSync: (request) =>
      ipcRenderer.invoke(ipcChannels.enqueueSyncTask, request),
    rules: (accountId) =>
      ipcRenderer.invoke(ipcChannels.getSyncRules, accountId),
    setRule: (request) => ipcRenderer.invoke(ipcChannels.setSyncRule, request),
    setMaxParallel: (value) =>
      ipcRenderer.invoke(ipcChannels.setTaskMaxParallel, value),
  },
  onTasksChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(ipcChannels.tasksChanged, handler);
    return () => ipcRenderer.removeListener(ipcChannels.tasksChanged, handler);
  },
  listPlugins: () => ipcRenderer.invoke(ipcChannels.listPlugins),
  listBundledPlugins: () => ipcRenderer.invoke(ipcChannels.listBundledPlugins),
  installBundledPlugin: (id) =>
    ipcRenderer.invoke(ipcChannels.installBundledPlugin, id),
  installPlugin: () => ipcRenderer.invoke(ipcChannels.installPlugin),
  restartForPluginChanges: () =>
    ipcRenderer.invoke(ipcChannels.restartForPluginChanges),
  changePlugin: (change) =>
    ipcRenderer.invoke(ipcChannels.changePlugin, change),
  setAccountSettings: (request) =>
    ipcRenderer.invoke(ipcChannels.setAccountSettings, request),
  listAccountBrowserRuntimes: () =>
    ipcRenderer.invoke(ipcChannels.listAccountBrowserRuntimes),
  onAccountBrowserRuntimesChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      runtimes: AccountBrowserRuntime[],
    ) => listener(runtimes);
    ipcRenderer.on(ipcChannels.accountBrowserRuntimesChanged, handler);
    return () =>
      ipcRenderer.removeListener(
        ipcChannels.accountBrowserRuntimesChanged,
        handler,
      );
  },
  getAccountBrowserState: (request) =>
    ipcRenderer.invoke(ipcChannels.getAccountBrowserState, request),
  beginAccountBrowserSwitch: (request) =>
    ipcRenderer.invoke(ipcChannels.beginAccountBrowserSwitch, request),
  getAccountBrowserSwitch: (request) =>
    ipcRenderer.invoke(ipcChannels.getAccountBrowserSwitch, request),
  cancelAccountBrowserSwitch: (request) =>
    ipcRenderer.invoke(ipcChannels.cancelAccountBrowserSwitch, request),
  getFingerprintBrowserStatus: () =>
    ipcRenderer.invoke(ipcChannels.getFingerprintBrowserStatus),
  installFingerprintBrowser: (request) =>
    ipcRenderer.invoke(ipcChannels.installFingerprintBrowser, request),
  cancelFingerprintBrowserInstall: (request) =>
    ipcRenderer.invoke(ipcChannels.cancelFingerprintBrowserInstall, request),
  onFingerprintBrowserChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: FingerprintBrowserStatus,
    ) => listener(state);
    ipcRenderer.on(ipcChannels.fingerprintBrowserChanged, handler);
    return () =>
      ipcRenderer.removeListener(
        ipcChannels.fingerprintBrowserChanged,
        handler,
      );
  },
  getPreferences: (request) =>
    ipcRenderer.invoke(ipcChannels.getPreferences, request),
  updatePreferences: (request) =>
    ipcRenderer.invoke(ipcChannels.updatePreferences, request),
  getApplicationUpdateState: () =>
    ipcRenderer.invoke(ipcChannels.getApplicationUpdateState),
  downloadApplicationUpdate: () =>
    ipcRenderer.invoke(ipcChannels.downloadApplicationUpdate),
  cancelApplicationUpdateDownload: () =>
    ipcRenderer.invoke(ipcChannels.cancelApplicationUpdateDownload),
  installApplicationUpdate: () =>
    ipcRenderer.invoke(ipcChannels.installApplicationUpdate),
  showApplicationUpdateFile: () =>
    ipcRenderer.invoke(ipcChannels.showApplicationUpdateFile),
  onApplicationUpdateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: ApplicationUpdateState,
    ) => listener(state);
    ipcRenderer.on(ipcChannels.applicationUpdateChanged, handler);
    return () =>
      ipcRenderer.removeListener(ipcChannels.applicationUpdateChanged, handler);
  },
  checkForApplicationUpdate: () =>
    ipcRenderer.invoke(ipcChannels.checkForApplicationUpdate),
  openApplicationUpdateDownload: (
    request: OpenApplicationUpdateDownloadRequest,
  ) => ipcRenderer.invoke(ipcChannels.openApplicationUpdateDownload, request),
  listPlatforms: () => ipcRenderer.invoke(ipcChannels.listPlatforms),
  listPlatformAccounts: () =>
    ipcRenderer.invoke(ipcChannels.listPlatformAccounts),
  createPlatformAccount: (request: CreatePlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.createPlatformAccount, request),
  openPlatformLogin: (request: OpenPlatformLoginRequest) =>
    ipcRenderer.invoke(ipcChannels.openPlatformLogin, request),
  openPlatformAccount: (request: PlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.openPlatformAccount, request),
  refreshPlatformAccount: (request: PlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.refreshPlatformAccount, request),
  refreshPlatformAccountProfile: (request: PlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.refreshPlatformAccountProfile, request),
  removePlatformAccount: (request: PlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.removePlatformAccount, request),
  onPlatformAccountsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(ipcChannels.platformAccountsChanged, handler);
    return () =>
      ipcRenderer.removeListener(ipcChannels.platformAccountsChanged, handler);
  },
  listPlatformContents: (request: PlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.listPlatformContents, request),
  onPlatformContentSyncProgress: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: PlatformContentSyncProgress,
    ) => listener(progress);
    ipcRenderer.on(ipcChannels.platformContentSyncProgress, handler);
    return () =>
      ipcRenderer.removeListener(
        ipcChannels.platformContentSyncProgress,
        handler,
      );
  },
  refreshPlatformContents: (request: PlatformAccountRequest) =>
    ipcRenderer.invoke(ipcChannels.refreshPlatformContents, request),
  openPlatformContent: (request) =>
    ipcRenderer.invoke(ipcChannels.openPlatformContent, request),
  selectPublishMedia: (request: SelectPublishMediaRequest) =>
    ipcRenderer.invoke(ipcChannels.selectPublishMedia, request),
  preparePublishDraft: (request: PreparePublishDraftRequest) =>
    ipcRenderer.invoke(ipcChannels.preparePublishDraft, request),
  queryPublications: (request: PublicationQuery) =>
    ipcRenderer.invoke(ipcChannels.queryPublications, request),
  openPublicationAsset: (request) =>
    ipcRenderer.invoke(ipcChannels.openPublicationAsset, request),
  getPublicationTask: (request: OpenPublicationRequest) =>
    ipcRenderer.invoke(ipcChannels.getPublicationTask, request),
  getPublicationPlatformContent: (request: OpenPublicationRequest) =>
    ipcRenderer.invoke(ipcChannels.getPublicationPlatformContent, request),
  recreatePublicationDraft: (
    request: OpenPublicationRequest,
  ): Promise<RecreatedPublicationDraft> =>
    ipcRenderer.invoke(ipcChannels.recreatePublicationDraft, request),
  resolvePublicationAttention: (request: {
    publicationId: string;
    resolution: PublicationAttentionResolution;
    manualPlatformContentId?: string;
  }) => ipcRenderer.invoke(ipcChannels.resolvePublicationAttention, request),
  selectPublicationContent: (request) =>
    ipcRenderer.invoke(ipcChannels.selectPublicationContent, request),
  reopenPublicationAttention: (request: { publicationId: string }) =>
    ipcRenderer.invoke(ipcChannels.reopenPublicationAttention, request),
  removePublicationArchiveRecord: (request) =>
    ipcRenderer.invoke(ipcChannels.removePublicationArchiveRecord, request),
  openPublicationReview: (request: OpenPublicationRequest) =>
    ipcRenderer.invoke(ipcChannels.openPublicationReview, request),
  openPublication: (request: OpenPublicationRequest) =>
    ipcRenderer.invoke(ipcChannels.openPublication, request),
  onPublishResultUpdate: (listener: (update: PublishResultUpdate) => void) => {
    ipcRenderer.on(ipcChannels.publishResultUpdate, (_event, update) => {
      listener(update as PublishResultUpdate);
    });
  },
  getLocalRuntimeSettings: () =>
    ipcRenderer.invoke(ipcChannels.getLocalRuntimeSettings),
  updateLocalRuntimeSettings: (request) =>
    ipcRenderer.invoke(ipcChannels.updateLocalRuntimeSettings, request),
  getRuntimeAccountAccess: (accountId) =>
    ipcRenderer.invoke(ipcChannels.getRuntimeAccountAccess, accountId),
  setRuntimeAccountAccess: (request) =>
    ipcRenderer.invoke(ipcChannels.setRuntimeAccountAccess, request),
  getLocalRuntimeStatus: () =>
    ipcRenderer.invoke(ipcChannels.getLocalRuntimeStatus),
  setLocalRuntimeRunning: (request: SetLocalRuntimeRunningRequest) =>
    ipcRenderer.invoke(ipcChannels.setLocalRuntimeRunning, request),
  getTechnicalInformation: () =>
    ipcRenderer.invoke(ipcChannels.getTechnicalInformation),
  openDiagnosticDirectory: () =>
    ipcRenderer.invoke(ipcChannels.openDiagnosticDirectory),
  findDiagnosticTrace: (request: FindDiagnosticTraceRequest) =>
    ipcRenderer.invoke(ipcChannels.findDiagnosticTrace, request),
  readDiagnosticTrace: (request: ReadDiagnosticTraceRequest) =>
    ipcRenderer.invoke(ipcChannels.readDiagnosticTrace, request),
  readDiagnosticAttachment: (request: ReadDiagnosticAttachmentRequest) =>
    ipcRenderer.invoke(ipcChannels.readDiagnosticAttachment, request),
  exportDiagnosticTrace: (request: ExportDiagnosticTraceRequest) =>
    ipcRenderer.invoke(ipcChannels.exportDiagnosticTrace, request),
};

contextBridge.exposeInMainWorld("matrix", Object.freeze(api));
