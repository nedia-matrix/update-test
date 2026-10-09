import type {
  PlatformModule,
  PublishInterruptionReason,
  PublishObservationSession,
  PublishResultEvent,
  PublishResultMonitor,
} from "@nedia-matrix/platform-sdk";

import type {
  PublicationSnapshot,
  PublicationAssetSnapshot,
  PublicationAttentionRepository,
  PublicationQuery,
  PublicationQueryResult,
  StartPreparationResult,
  StartPublicationInput,
} from "./index.js";
import type {
  PublicationAssetRole,
  PublishContentForm,
} from "../domain/index.js";

export interface PlatformCatalog {
  get(id: string): PlatformModule | undefined;
  require(id: string): PlatformModule;
  list(): readonly PlatformModule[];
}

export interface PublicationAccountView {
  readonly id: string;
  readonly platformId: string;
  readonly profileId: string;
  readonly lifecycle: "pending_identity" | "active";
  readonly displayName: string;
  readonly identityScheme: string | null;
  readonly externalAccountId: string | null;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
  readonly status: "authenticated" | "login_required" | "unknown";
  readonly lastVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicationAccountReader {
  require(accountId: string): PublicationAccountView;
}

export interface PublicationBrowserPage {
  readonly id: string;
  readonly driver: unknown;
  readonly profileId: string;
  readonly observationSession?: PublishObservationSession;
  focus(): Promise<void>;
  handoff(): Promise<void>;
  verifyIdentity(): Promise<void>;
  release(): Promise<void>;
}

export interface PublicationBrowserPort {
  openUserPage(
    account: PublicationAccountView,
    platform: PlatformModule,
  ): Promise<unknown>;
  openForPublication(
    account: PublicationAccountView,
    platform: PlatformModule,
    publicationId: string,
    diagnostics?: PublishAutomationDiagnosticTrace,
  ): Promise<PublicationBrowserPage>;
  focusPublication(publicationId: string): Promise<void>;
}

export interface MediaSelection {
  readonly accountId: string;
  readonly contentForm: PublishContentForm;
  readonly resourceReferences: readonly string[];
  readonly files: StartPublicationInput["assets"];
  readonly createdAt: number;
}

export interface MediaSelectionPort {
  create(input: {
    accountId: string;
    contentForm: PublishContentForm;
    resourceReferences: readonly string[];
    files: StartPublicationInput["assets"];
  }): string;
  acquire(
    id: string,
    accountId: string,
    contentForm: PublishContentForm,
  ): MediaSelection;
  release(id: string): void;
  consume(id: string): void;
}

export class MediaSelectionUnavailableError extends TypeError {
  constructor() {
    super("Media selection is missing, expired, or in use");
    this.name = "MediaSelectionUnavailableError";
  }
}

export interface RemotePublicationAsset {
  url: string;
  name: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
  role: PublicationAssetRole;
  order: number;
  sourceAssetId?: string;
}

export interface DownloadedPublicationAsset {
  created: boolean;
  resourceReference: string;
  hash: string;
  localRelativePath: string;
  mediaType: RemotePublicationAsset["mediaType"];
  name: string;
  order: number;
  role: PublicationAssetRole;
  size: number;
  sourceAssetId: string | null;
  sourceOrigin: string;
  downloadedAt: string;
}

export interface RemotePublicationAssetPort {
  download(
    requestId: string,
    assets: readonly RemotePublicationAsset[],
  ): Promise<DownloadedPublicationAsset[]>;
  discardUnreferenced(
    assets: readonly DownloadedPublicationAsset[],
    referencedRelativePaths: ReadonlySet<string>,
  ): Promise<void>;
}

export interface PublicationLease {
  release(): void;
}

export interface AccountPublicationPort {
  acquire(accountId: string): PublicationLease | null;
  isActive(accountId: string): boolean;
  hasAnyActive?(): boolean;
}

export interface ManagedPublishObservation {
  readonly id: string;
  ready(): Promise<void>;
  arm(): void;
  beginSubmissionAttempt(): Promise<void>;
  interrupt(reason?: PublishInterruptionReason): Promise<void>;
  stopSilently(): Promise<void>;
}

export interface PublishObservationPort {
  attach(input: {
    publicationId: string;
    accountId: string;
    platformId: string;
    monitor: PublishResultMonitor;
    diagnostics?: PublishAutomationDiagnosticTrace;
    onFinished?: (result?: PublishResultEvent) => void | Promise<void>;
  }): ManagedPublishObservation;
}

export interface PublicationStatePort {
  list(): PublicationSnapshot[];
  get(publicationId: string): PublicationSnapshot | undefined;
  startPreparation(input: StartPublicationInput): StartPreparationResult;
  markAwaitingConfirmation(publicationId: string): PublicationSnapshot;
  markSubmitting(publicationId: string): PublicationSnapshot;
  markPreparationFailed(
    publicationId: string,
    message: string,
  ): PublicationSnapshot;
  markSubmissionUncertain(
    publicationId: string,
    message: string,
  ): PublicationSnapshot;
  recordObservation(
    publicationId: string,
    result: PublishResultEvent,
    sequence?: number,
  ): PublicationSnapshot;
  recoverInterrupted(): PublicationSnapshot[];
}

export interface PublicationQueryPort {
  query(input: PublicationQuery): {
    records: PublicationSnapshot[];
    nextCursor: string | null;
    counts: PublicationQueryResult["counts"];
    tabCounts: PublicationQueryResult["tabCounts"];
    total: number;
  };
}

export interface PublishWorkflowInputs {
  mediaReferences?: readonly string[];
  title?: string;
  body?: string;
  description?: string;
  tags?: readonly string[];
}

export interface PublishWorkflowExecutionOptions {
  beforeCommit?(input: { boundary: string }): Promise<void>;
  trace?: unknown;
}

export interface PublishWorkflowExecutor {
  execute(
    workflow: unknown,
    driver: unknown,
    inputs: PublishWorkflowInputs,
    options?: PublishWorkflowExecutionOptions,
  ): Promise<void>;
}

export interface PublishFailureDetails {
  code: string;
  evidenceId: string | null;
}

export interface PublishFailureClassifier {
  classify(error: unknown): PublishFailureDetails | undefined;
}

export interface PublishMonitorClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface PublishDiagnosticSink {
  report(input: {
    platformId: string;
    stage: string;
    code: string;
    message: string;
  }): void;
}

export interface PublishAutomationDiagnosticEvent {
  readonly component:
    "application" | "browser" | "session" | "monitor" | "evidence";
  readonly event: string;
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PublishAutomationDiagnosticTrace {
  readonly traceId: string;
  bind(input: { publicationId?: string; pageId?: string }): void;
  report(input: PublishAutomationDiagnosticEvent): void;
  execution(phase: "prepare" | "submit"): unknown;
  finish(input: { outcome: string; message?: string }): void;
}

export interface PublishAutomationDiagnosticPort {
  start(input: {
    operation: "publication.prepare";
    requestId: string;
    accountId: string;
    platformId: string;
  }): PublishAutomationDiagnosticTrace;
}

export interface PublicationNoticePort {
  show(
    notice:
      | {
          kind: "publish.awaiting_confirmation";
          accountId: string;
          publicationId: string;
        }
      | {
          kind:
            | "publish.preparation_failed"
            | "publish.failed"
            | "publish.uncertain";
          accountId: string;
          publicationId?: string;
          message?: string;
          pageAvailable: boolean;
        },
  ): void;
}

export interface PublicationApplicationDependencies {
  platforms: PlatformCatalog;
  accounts: PublicationAccountReader;
  browser: PublicationBrowserPort;
  mediaSelections: MediaSelectionPort;
  remoteAssets: RemotePublicationAssetPort;
  accountPublications: AccountPublicationPort;
  observations: PublishObservationPort;
  publishing: PublicationStatePort;
  query?: PublicationQueryPort;
  attention?: PublicationAttentionRepository;
  selection?: {
    selectedContentId(publicationId: string): string | null;
    selectContent(publicationId: string, externalContentId: string): void;
  };
  hasActivePublication?(publicationId: string): boolean;
  resolveArchiveAssetPath?(relativePath: string): Promise<string | undefined>;
  verifyAccount(request: {
    accountId: string;
  }): Promise<
    | { status: "authenticated" }
    | { status: "login_required" }
    | { status: "unknown"; reason: string }
  >;
  createId(): string;
  workflow: PublishWorkflowExecutor;
  failureClassifier: PublishFailureClassifier;
  monitorClock: PublishMonitorClock;
  diagnostics: PublishDiagnosticSink;
  automationDiagnostics?: PublishAutomationDiagnosticPort;
  notices?: PublicationNoticePort;
}

export interface StoredPublicationAsset {
  relativePath: string;
  size: number;
}

export interface PublicationArchiveRepository {
  get(publicationId: string): PublicationSnapshot | undefined;
  list(): PublicationSnapshot[];
  save(record: PublicationSnapshot): void;
  remove(publicationId: string): void;
  isDeletedRequestId?(requestId: string): boolean;
}

export interface PublicationArchiveAssetStore {
  list(): Promise<StoredPublicationAsset[]>;
  remove(relativePath: string): Promise<void>;
  resolvePath?(relativePath: string): Promise<string | undefined>;
}

export type PublicationAssetInput = Pick<
  PublicationAssetSnapshot,
  "name" | "size"
> &
  Partial<Omit<PublicationAssetSnapshot, "id" | "name" | "size">>;
