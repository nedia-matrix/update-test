import { randomUUID } from "node:crypto";

import {
  AutomationError,
  detectPlatformSession,
  executeWorkflow,
} from "@nedia-matrix/automation-engine";
import type {
  AutomationDriver,
  AutomationWorkflow,
  WorkflowExecutionHooks,
  WorkflowInputs,
} from "@nedia-matrix/automation-engine";
import { createBrowserProfileId } from "@nedia-matrix/automation-playwright";
import type {
  AccountDiagnosticPort,
  AccountDiagnosticTrace,
  PlatformAccountSnapshot,
} from "@nedia-matrix/account-management";
import {
  PublicationService,
  PublicationArchiveMaintenance,
  type PublicationArchiveAssetStore,
  type PublicationArchiveRepository,
  type PublicationApplicationDependencies,
  type PublishAutomationDiagnosticPort,
  type PublicationUseCases,
  type PrepareRemoteDraftRequest,
} from "@nedia-matrix/publishing";
import {
  AccountService,
  type AccountUseCases,
  type AccountRepository,
  type BrowserSessionPort,
} from "@nedia-matrix/account-management";
import {
  PlatformContentService,
  type PlatformContentAutomationDiagnosticPort,
  type PlatformContentAutomationDiagnosticTrace,
  type PlatformContentRepository,
  type PlatformContentSnapshot,
  type PlatformContentSyncRun,
} from "@nedia-matrix/platform-content";
import type {
  ApplicationUpdateCheckResult,
  ApplicationUpdateState,
  LocalRuntimeStatus,
  OpenApplicationUpdateDownloadRequest,
  PlatformSummary,
  SetLocalRuntimeRunningRequest,
} from "../../bridge/contracts.js";
import type { PlatformRegistry } from "../platforms/platform-registry.js";
import { toPlatformSummary } from "../platforms/platform-summary.js";

import { ApplicationCommandGate } from "./application-command-gate.js";

export interface RuntimeUseCases {
  status(): LocalRuntimeStatus;
  setRunning(
    request: SetLocalRuntimeRunningRequest,
  ): Promise<LocalRuntimeStatus>;
}

export interface UpdateUseCases {
  check(): Promise<ApplicationUpdateCheckResult>;
  state(): ApplicationUpdateState;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  install(): Promise<void>;
  showFile(): Promise<void>;
  openDownload(request: OpenApplicationUpdateDownloadRequest): Promise<void>;
}

export interface PlatformContentUseCases {
  list(accountId: string): PlatformContentSnapshot[];
  queryByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
    externalContentIds: readonly string[];
  }): {
    contents: PlatformContentSnapshot[];
    latestRun: PlatformContentSyncRun | undefined;
  };
  latestRun(accountId: string): PlatformContentSyncRun | undefined;
  contentUrl(accountId: string, externalContentId: string): string;
  refresh(accountId: string): Promise<PlatformContentSyncRun>;
  refreshByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
  }): Promise<PlatformContentSyncRun>;
}

export interface NediaMatrixUseCases {
  readonly platforms: PlatformRegistry;
  readonly platformSummaries: () => PlatformSummary[];
  readonly accounts: AccountUseCases;
  readonly publications: PublicationUseCases;
  readonly publicationPlatformContent: (publicationId: string) => {
    content: PlatformContentSnapshot | null;
    latestRun: PlatformContentSyncRun | null;
    accountMissing: boolean;
  };
  readonly platformContents: PlatformContentUseCases;
  readonly runtime: RuntimeUseCases;
  readonly updates: UpdateUseCases;
}

export type NediaMatrixApplicationEvent =
  | { type: "accounts.changed" }
  | { type: "publication.changed"; publicationId: string };

export interface DesktopEventSink {
  publish(event: NediaMatrixApplicationEvent): void;
}

interface NediaMatrixApplicationDependencies {
  platforms: PlatformRegistry;
  runtime: RuntimeUseCases;
  updates: UpdateUseCases;
  accountStore: AccountRepository;
  platformContents: PlatformContentRepository;
  browserSessions: PublicationApplicationDependencies["browser"] &
    Omit<BrowserSessionPort, "openForVerification"> & {
      hasPublicationPage?(publicationId: string): boolean;
      hasAnyPublicationPage?(): boolean;
      openForVerification(
        account: Parameters<BrowserSessionPort["openForVerification"]>[0],
        platform: Parameters<BrowserSessionPort["openForVerification"]>[1],
        diagnostics?:
          AccountDiagnosticTrace | PlatformContentAutomationDiagnosticTrace,
      ): ReturnType<BrowserSessionPort["openForVerification"]>;
    };
  mediaSelections: PublicationApplicationDependencies["mediaSelections"] & {
    removeForAccount(accountId: string): void;
  };
  publishObservations: PublicationApplicationDependencies["observations"] & {
    stop(accountId: string): Promise<void>;
  };
  accountPublications: PublicationApplicationDependencies["accountPublications"];
  publishing: PublicationApplicationDependencies["publishing"];
  publicationArchive: PublicationArchiveRepository;
  publicationSelection?: NonNullable<
    PublicationApplicationDependencies["selection"]
  >;
  publicationAttention: PublicationApplicationDependencies["attention"];
  publicationQuery: PublicationApplicationDependencies["query"];
  publicationArchiveAssets: PublicationArchiveAssetStore;
  remoteAssets: PublicationApplicationDependencies["remoteAssets"];
  notices?: PublicationApplicationDependencies["notices"];
  automationDiagnostics?: PublishAutomationDiagnosticPort &
    PlatformContentAutomationDiagnosticPort &
    AccountDiagnosticPort;
  archiveDiagnostics?: {
    report(input: {
      event: string;
      details: Readonly<Record<string, unknown>>;
    }): void;
  };
  createId?: (() => string) | undefined;
  now?: (() => Date) | undefined;
  sessionDetector?: typeof detectPlatformSession | undefined;
  workflowExecutor?: typeof executeWorkflow | undefined;
  eventSink?: DesktopEventSink | undefined;
  removeAccountResources(account: PlatformAccountSnapshot): Promise<void>;
}

export type { PrepareRemoteDraftRequest };

export class NediaMatrixApplication implements NediaMatrixUseCases {
  private readonly commands = new ApplicationCommandGate();
  private readonly accountApplication: AccountService;
  private readonly publishing: PublicationService;
  private readonly archiveMaintenance: PublicationArchiveMaintenance;
  private readonly contentSync: PlatformContentService;

  readonly accounts: AccountUseCases;
  readonly platforms: PlatformRegistry;
  readonly platformSummaries: () => PlatformSummary[];
  readonly publications: PublicationUseCases;
  readonly publicationPlatformContent: NediaMatrixUseCases["publicationPlatformContent"];
  readonly platformContents: PlatformContentUseCases;
  readonly runtime: RuntimeUseCases;
  readonly updates: UpdateUseCases;

  constructor(dependencies: NediaMatrixApplicationDependencies) {
    const createId = dependencies.createId ?? randomUUID;
    const sessionDetector =
      dependencies.sessionDetector ?? detectPlatformSession;
    this.platforms = dependencies.platforms;
    this.platformSummaries = () => this.platforms.list().map(toPlatformSummary);
    this.runtime = this.commands.guard(dependencies.runtime);
    // Update commands own their mutex; tracking installation here would deadlock shutdown.
    this.updates = dependencies.updates;
    this.accountApplication = new AccountService({
      platforms: dependencies.platforms,
      accountStore: dependencies.accountStore,
      browserSessions: dependencies.browserSessions,
      removeAccountResources: dependencies.removeAccountResources,
      createId,
      createProfileId: createBrowserProfileId,
      now: dependencies.now,
      sessionDetector,
      isAccountBusy: (accountId) =>
        dependencies.accountPublications.isActive(accountId),
      onAccountsChanged: () =>
        dependencies.eventSink?.publish({ type: "accounts.changed" }),
      diagnostics: dependencies.automationDiagnostics,
    });
    this.publishing = new PublicationService({
      platforms: dependencies.platforms,
      accounts: dependencies.accountStore,
      browser: dependencies.browserSessions,
      mediaSelections: dependencies.mediaSelections,
      remoteAssets: dependencies.remoteAssets,
      accountPublications: dependencies.accountPublications,
      observations: dependencies.publishObservations,
      publishing: dependencies.publishing,
      attention: dependencies.publicationAttention,
      selection: dependencies.publicationSelection,
      hasActivePublication: (publicationId) =>
        dependencies.browserSessions.hasPublicationPage?.(publicationId) ??
        false,
      query: dependencies.publicationQuery,
      resolveArchiveAssetPath: (relativePath) =>
        dependencies.publicationArchiveAssets.resolvePath?.(relativePath) ??
        Promise.resolve(undefined),
      verifyAccount: (request) =>
        this.accountApplication.verifyAccount(request),
      createId,
      workflow: publicationWorkflowAdapter(
        dependencies.workflowExecutor ?? executeWorkflow,
      ),
      failureClassifier: {
        classify: (error) =>
          error instanceof AutomationError
            ? {
                code: error.details.code,
                evidenceId: error.details.evidence?.id ?? null,
              }
            : undefined,
      },
      monitorClock: {
        now: () => Date.now(),
        sleep: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
      diagnostics: {
        report: ({ platformId, stage, code, message }) => {
          if (!dependencies.automationDiagnostics) {
            console.error(
              `[publish-monitor:${platformId}] ${stage}/${code}: ${message}`,
            );
          }
        },
      },
      automationDiagnostics: dependencies.automationDiagnostics,
      notices: dependencies.notices,
    });
    this.archiveMaintenance = new PublicationArchiveMaintenance(
      dependencies.publicationArchive,
      dependencies.publicationArchiveAssets,
      {
        hasActiveTask: (publicationId) => {
          const publication = dependencies.publishing.get(publicationId);
          return publication
            ? dependencies.accountPublications.isActive(
                publication.publication.accountId,
              ) ||
                (dependencies.browserSessions.hasPublicationPage?.(
                  publicationId,
                ) ??
                  false)
            : false;
        },
        hasActiveAssetUsers: () =>
          (dependencies.accountPublications.hasAnyActive?.() ?? false) ||
          (dependencies.browserSessions.hasAnyPublicationPage?.() ?? false),
        now: dependencies.now ?? (() => new Date()),
      },
      dependencies.archiveDiagnostics,
    );
    this.contentSync = new PlatformContentService({
      accounts: {
        require: (accountId) => dependencies.accountStore.require(accountId),
        updateContentCount: (accountId, contentCount, observedAt) =>
          this.accountApplication.updateContentCount(
            accountId,
            contentCount,
            observedAt,
          ),
      },
      platforms: dependencies.platforms,
      browser: {
        open: async (accountId, platform, diagnostics) => {
          const account = dependencies.accountStore.require(accountId);
          const opened = await dependencies.browserSessions.openForVerification(
            account,
            platform,
            diagnostics,
          );
          return {
            dataClient: opened.dataClient,
            verify: () =>
              sessionDetector(
                platform.accounts.detection,
                opened.driver,
                opened.sessionProbeClient,
              ),
            close: opened.close,
          };
        },
      },
      repository: dependencies.platformContents,
      createId,
      now: dependencies.now ?? (() => new Date()),
      automationDiagnostics: dependencies.automationDiagnostics,
    });
    this.accounts = {
      list: () => this.accountApplication.listAccounts(),
      resolve: (request) => this.accountApplication.resolveAccount(request),
      resolveByExternalIdentity: (request) =>
        this.accountApplication.resolveByExternalIdentity(request),
      verifyByExternalIdentity: (request) =>
        this.accountApplication.verifyByExternalIdentity(request),
      create: (request) => this.accountApplication.createAccount(request),
      openLogin: (request) => this.accountApplication.openLogin(request),
      open: (request) => this.accountApplication.openAccount(request),
      refresh: (request) => this.accountApplication.refreshAccount(request),
      refreshProfile: (request) =>
        this.accountApplication.refreshAccountProfile(request),
      verify: (request) => this.accountApplication.verifyAccount(request),
      remove: (request) => this.accountApplication.removeAccount(request),
      cleanupRetiredProfiles: () =>
        this.accountApplication.cleanupRetiredProfiles(),
    };
    this.publications = {
      list: () => this.publishing.list(),
      listTasks: () => this.publishing.listTasks(),
      getTask: (publicationId) => this.publishing.getTask(publicationId),
      recreateDraft: (publicationId) =>
        this.publishing.recreateDraft(publicationId),
      queryTasks: (request) => this.publishing.queryTasks(request),
      resolveAttention: (request) => {
        if (request.resolution === "confirmed_published")
          this.requirePublicationContent(
            request.publicationId,
            request.manualPlatformContentId ?? "",
          );
        return this.publishing.resolveAttention(request);
      },
      reopenAttention: (publicationId) =>
        this.publishing.reopenAttention(publicationId),
      selectContent: (publicationId, externalContentId) => {
        this.requirePublicationContent(publicationId, externalContentId);
        return this.publishing.selectContent(publicationId, externalContentId);
      },
      archiveUsage: () => this.archiveMaintenance.usage(),
      cleanupArchive: (policy) => this.archiveMaintenance.cleanup(policy),
      setArchiveRetained: (publicationId, retained) => {
        this.archiveMaintenance.setRetained(publicationId, retained);
        const task = this.publishing.getTask(publicationId);
        if (!task) throw new TypeError("Publication does not exist");
        return task;
      },
      removeArchivePublication: (publicationId) =>
        this.archiveMaintenance.removePublication(publicationId),
      wasDeleted: (requestId) =>
        dependencies.publicationArchive.isDeletedRequestId?.(requestId) ??
        false,
      openReview: (request) => this.publishing.openReview(request),
      publicationUrl: (request) => {
        const task = this.publishing.getTask(request.publicationId);
        if (!task) throw new TypeError("Publication does not exist");
        const selectedId =
          task.selectedPlatformContentId ?? task.manualPlatformContentId;
        return selectedId
          ? this.contentSync.contentUrl(task.accountId, selectedId)
          : this.publishing.publicationUrl(request);
      },
      prepareRemote: (request) => this.publishing.prepareRemote(request),
      prepare: (request) => this.publishing.prepare(request),
      registerLocalMedia: (request) =>
        this.publishing.registerLocalMedia(request),
      recordObservation: (publicationId, result, sequence) =>
        this.publishing.recordObservation(publicationId, result, sequence),
      recoverInterrupted: () => this.publishing.recoverInterrupted(),
    };
    this.publicationPlatformContent = (publicationId) => {
      const task = this.publishing.getTask(publicationId);
      const contentId =
        task?.selectedPlatformContentId ??
        task?.manualPlatformContentId ??
        task?.platformContentId;
      if (!task || !contentId)
        return { content: null, latestRun: null, accountMissing: false };
      let account;
      try {
        account = this.accountApplication.resolveAccount({
          accountId: task.accountId,
        }).account;
      } catch {
        return { content: null, latestRun: null, accountMissing: true };
      }
      const content =
        this.contentSync
          .findMany(account.id, [contentId])
          .find(
            (item) =>
              item.platformId === task.platformId &&
              item.accountId === task.accountId &&
              item.externalContentId === contentId,
          ) ?? null;
      return {
        content,
        latestRun: this.contentSync.latestRun(account.id) ?? null,
        accountMissing: false,
      };
    };
    this.platformContents = {
      list: (accountId) => this.contentSync.list(accountId),
      queryByExternalIdentity: (request) => {
        const account = this.accountApplication.resolveByExternalIdentity({
          platformId: request.platformId,
          externalAccountId: request.externalAccountId,
        });
        return {
          contents: this.contentSync.findMany(
            account.id,
            request.externalContentIds,
          ),
          latestRun: this.contentSync.latestRun(account.id),
        };
      },
      latestRun: (accountId) => this.contentSync.latestRun(accountId),
      contentUrl: (accountId, externalContentId) =>
        this.contentSync.contentUrl(accountId, externalContentId),
      refresh: (accountId) => this.contentSync.refresh(accountId),
      refreshByExternalIdentity: (request) => {
        const account = this.accountApplication.resolveByExternalIdentity({
          platformId: request.platformId,
          externalAccountId: request.externalAccountId,
        });
        return this.contentSync.refresh(account.id);
      },
    };
    this.accounts = this.commands.guard(this.accounts);
    this.publications = this.commands.guard(this.publications);
    this.publicationPlatformContent = this.commands.guard({
      get: this.publicationPlatformContent,
    }).get;
    this.platformContents = this.commands.guard(this.platformContents);
  }

  freezeForUpdate(): () => void {
    return this.commands.freezeForUpdate();
  }

  stopCommands(): Promise<void> {
    return this.commands.stop();
  }

  private requirePublicationContent(
    publicationId: string,
    externalContentId: string,
  ): PlatformContentSnapshot {
    const task = this.publishing.getTask(publicationId);
    if (!task) throw new TypeError("Publication does not exist");
    if (typeof externalContentId !== "string" || !externalContentId.trim())
      throw new TypeError("A platform work must be selected");
    const content = this.contentSync
      .findMany(task.accountId, [externalContentId])
      .find(
        (item) =>
          item.platformId === task.platformId &&
          item.accountId === task.accountId &&
          item.externalContentId === externalContentId,
      );
    if (!content)
      throw new TypeError(
        "Selected platform work is not in this account snapshot",
      );
    return content;
  }
}

function publicationWorkflowAdapter(
  executor: typeof executeWorkflow,
): PublicationApplicationDependencies["workflow"] {
  return {
    execute: (workflow, driver, inputs, options) => {
      const { mediaReferences, ...textInputs } = inputs;
      const workflowInputs: WorkflowInputs = {
        ...textInputs,
        ...(mediaReferences === undefined
          ? {}
          : { mediaPaths: mediaReferences }),
      };
      const beforeCommit = options?.beforeCommit;
      const trace = options?.trace as WorkflowExecutionHooks["trace"];
      const hooks: WorkflowExecutionHooks = {
        ...(beforeCommit
          ? {
              beforeCommit: ({ boundary }) => beforeCommit({ boundary }),
            }
          : {}),
        ...(trace ? { trace } : {}),
      };
      return executor(
        workflow as AutomationWorkflow,
        driver as AutomationDriver,
        workflowInputs,
        hooks,
      );
    },
  };
}
