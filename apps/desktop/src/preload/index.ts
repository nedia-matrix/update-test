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

const api: MatrixDesktopApi = {
  getPreferences: (request) =>
    ipcRenderer.invoke(ipcChannels.getPreferences, request),
  updatePreferences: (request) =>
    ipcRenderer.invoke(ipcChannels.updatePreferences, request),
  getApplicationUpdateState: () => ipcRenderer.invoke(ipcChannels.getApplicationUpdateState),
  downloadApplicationUpdate: () => ipcRenderer.invoke(ipcChannels.downloadApplicationUpdate),
  cancelApplicationUpdateDownload: () => ipcRenderer.invoke(ipcChannels.cancelApplicationUpdateDownload),
  showApplicationUpdateFile: () => ipcRenderer.invoke(ipcChannels.showApplicationUpdateFile),
  onApplicationUpdateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ApplicationUpdateState) => listener(state);
    ipcRenderer.on(ipcChannels.applicationUpdateChanged, handler);
    return () => ipcRenderer.removeListener(ipcChannels.applicationUpdateChanged, handler);
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
  getLocalRuntimeStatus: () =>
    ipcRenderer.invoke(ipcChannels.getLocalRuntimeStatus),
  setLocalRuntimeRunning: (request: SetLocalRuntimeRunningRequest) =>
    ipcRenderer.invoke(ipcChannels.setLocalRuntimeRunning, request),
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
