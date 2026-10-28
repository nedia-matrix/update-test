import { TaskCoordinator } from "../scheduling/task-coordinator.js";
import type { TaskStore } from "../scheduling/task-store.js";
import type { TaskUseCases } from "../../bridge/tasks.js";
import { samePlatform } from "@nedia-matrix/platform-sdk";
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
  AccountBrowserPage,
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
  type PlatformContentSyncProgress,
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
import { platformSummaries } from "../platforms/platform-registry.js";

import { AccountActivityGate } from "./account-activity-gate.js";
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
  refresh(
    accountId: string,
    onProgress?: (progress: PlatformContentSyncProgress) => void,
  ): Promise<PlatformContentSyncRun>;
  refreshByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
  }): Promise<PlatformContentSyncRun>;
}

export interface NediaMatrixUseCases {
  readonly tasks?: TaskUseCases;
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
  | { type: "tasks.changed" }
  | { type: "accounts.changed" }
  | { type: "publication.changed"; publicationId: string };

export interface DesktopEventSink {
  publish(event: NediaMatrixApplicationEvent): void;
}

interface NediaMatrixApplicationDependencies {
  taskStore?: TaskStore;
  platforms: PlatformRegistry;
  createProfileId?: (platformId: string, accountId: string) => string;
  runtime: RuntimeUseCases;
  updates: UpdateUseCases;
  accountStore: AccountRepository;
  platformContents: PlatformContentRepository;
  browserSessions: PublicationApplicationDependencies["browser"] &
    Omit<BrowserSessionPort, "openForVerification"> & {
      hasPublicationPage?(publicationId: string): boolean;
      isBrowserUnderMaintenance?(): boolean;
      isAccountBrowserBusy?(accountId: string, profileId: string): boolean;
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
  pluginPublishing?: PublicationApplicationDependencies["pluginPublishing"];
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
  private readonly publicationBusy: (accountId: string) => boolean;
  private readonly accountActivity = new AccountActivityGate();
  private readonly commands = new ApplicationCommandGate();
  private readonly accountApplication: AccountService;
  private readonly publishing: PublicationService;
  private readonly archiveMaintenance: PublicationArchiveMaintenance;
  private readonly contentSync: PlatformContentService;
  private coordinator?: TaskCoordinator;
  readonly tasks?: TaskUseCases;

  readonly accounts: AccountUseCases;
  readonly platforms: PlatformRegistry;
  readonly platformSummaries: () => PlatformSummary[];
  readonly publications: PublicationUseCases;
  readonly publicationPlatformContent: NediaMatrixUseCases["publicationPlatformContent"];
  readonly platformContents: PlatformContentUseCases;
  readonly runtime: RuntimeUseCases;
  readonly updates: UpdateUseCases;

  constructor(dependencies: NediaMatrixApplicationDependencies) {
    this.publicationBusy = (accountId) =>
      dependencies.accountPublications.isActive(accountId);
    const createId = dependencies.createId ?? randomUUID;
    const sessionDetector =
      dependencies.sessionDetector ?? detectPlatformSession;
    this.platforms = dependencies.platforms;
    this.platformSummaries = () => platformSummaries(this.platforms);
    this.runtime = this.commands.guard(dependencies.runtime);
    // Update commands own their mutex; tracking installation here would deadlock shutdown.
    this.updates = dependencies.updates;
    this.accountApplication = new AccountService({
      platforms: dependencies.platforms,
      accountStore: dependencies.accountStore,
      browserSessions: dependencies.browserSessions,
      removeAccountResources: dependencies.removeAccountResources,
      createId,
      createProfileId: dependencies.createProfileId ?? createBrowserProfileId,
      now: dependencies.now,
      sessionDetector,
      isAccountBusy: (accountId) =>
        dependencies.accountPublications.isActive(accountId) ||
        this.accountActivity.isSwitching(accountId) ||
        (!!this.coordinator?.scheduler.isBusy(accountId) &&
          !this.coordinator.owns(accountId)),
      assertAccountAvailable: (accountId) => {
        this.accountActivity.assertAvailable(accountId);
        if (
          this.coordinator?.scheduler.isBusy(accountId) &&
          !this.coordinator.owns(accountId)
        )
          throw new Error("账号存在执行中的任务");
      },
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
      pluginPublishing: dependencies.pluginPublishing,
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
      verifyAccount: (request, page) =>
        this.accountApplication.verifyAccountOnPage(request, {
          driver: page.driver as AccountBrowserPage["driver"],
          sessionProbeClient:
            page.sessionProbeClient as AccountBrowserPage["sessionProbeClient"],
        }),
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
          if (this.coordinator?.protectsPublication(publicationId)) return true;
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
          !!this.coordinator?.hasProtectedAssets() ||
          (dependencies.accountPublications.hasAnyActive?.() ?? false) ||
          (dependencies.browserSessions.hasAnyPublicationPage?.() ?? false),
        additionalReferencedPaths: () =>
          this.coordinator?.protectedPaths() ?? new Set<string>(),
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
      preserveMissing: !!dependencies.taskStore,
      createId,
      now: dependencies.now ?? (() => new Date()),
      automationDiagnostics: dependencies.automationDiagnostics,
    });
    this.accounts = {
      setSettings: async (request) => {
        const accountId =
          this.accountApplication.resolveAccount(request).account.id;
        if (
          this.accountActivity.isBusy(accountId) ||
          this.publicationBusy(accountId)
        )
          throw new Error("账号存在发布、同步或环境切换，暂不能修改平台设置");
        return this.accountApplication.setSettings(request);
      },
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
              samePlatform(this.platforms, item.platformId, task.platformId) &&
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
      refresh: (accountId, onProgress) =>
        this.contentSync.refresh(accountId, onProgress),
      refreshByExternalIdentity: (request) => {
        const account = this.accountApplication.resolveByExternalIdentity({
          platformId: request.platformId,
          externalAccountId: request.externalAccountId,
        });
        return this.contentSync.refresh(account.id);
      },
    };
    if (dependencies.taskStore) {
      this.coordinator = new TaskCoordinator({
        store: dependencies.taskStore,
        accounts: this.accountApplication,
        content: this.contentSync,
        publications: this.publishing,
        ports: {
          accounts: dependencies.accountStore,
          platforms: dependencies.platforms,
          publishing: dependencies.publishing,
          accountPublications: dependencies.accountPublications,
          mediaSelections: dependencies.mediaSelections,
          remoteAssets: dependencies.remoteAssets,
        },
        wasDeleted: (requestId) =>
          dependencies.publicationArchive.isDeletedRequestId?.(requestId) ??
          false,
        resolveAsset: (path) =>
          dependencies.publicationArchiveAssets.resolvePath?.(path) ??
          Promise.resolve(undefined),
        canStart: (accountId) =>
          !dependencies.browserSessions.isBrowserUnderMaintenance?.() &&
          !this.accountActivity.isBusy(accountId) &&
          !dependencies.accountPublications.isActive(accountId) &&
          !this.accountApplication.hasActiveOperation(accountId),
        changed: () =>
          dependencies.eventSink?.publish({ type: "tasks.changed" }),
        onError: (error) =>
          console.error("Task scheduler stopped safely", error),
      });
      this.tasks = this.commands.guard(this.coordinator.scheduler);
      const coordinator = this.coordinator;
      this.accounts = {
        ...this.accounts,
        refreshProfile: async (request) => {
          const task = coordinator.scheduler.enqueueSync({
            accountId: request.accountId,
            type: "account_profile_sync",
          });
          return (await coordinator.scheduler.wait(task.id)) as Awaited<
            ReturnType<AccountUseCases["refreshProfile"]>
          >;
        },
      };
      this.platformContents = {
        ...this.platformContents,
        refresh: async (accountId) => {
          const task = coordinator.scheduler.enqueueSync({
            accountId,
            type: "platform_content_sync",
          });
          return (await coordinator.scheduler.wait(
            task.id,
          )) as PlatformContentSyncRun;
        },
        refreshByExternalIdentity: async (request) => {
          const account =
            this.accountApplication.resolveByExternalIdentity(request);
          const task = coordinator.scheduler.enqueueSync(
            { accountId: account.id, type: "platform_content_sync" },
            "runtime",
          );
          return (await coordinator.scheduler.wait(
            task.id,
          )) as PlatformContentSyncRun;
        },
      };
      this.publications = {
        ...this.publications,
        prepare: async (request) => coordinator.enqueueLocal(request),
        prepareRemote: (request) => coordinator.enqueueRemote(request),
      };
    }
    const requestAccount = (args: unknown[]) => {
      const request = args[0] as
        | {
            accountId?: string;
            platformId?: string;
            externalAccountId?: string;
          }
        | undefined;
      if (request?.accountId)
        return dependencies.accountStore.resolve(request.accountId).account.id;
      return request?.externalAccountId
        ? dependencies.accountStore
            .list()
            .find(
              (account) =>
                samePlatform(
                  this.platforms,
                  account.platformId,
                  request.platformId ?? "",
                ) && account.externalAccountId === request.externalAccountId,
            )?.id
        : undefined;
    };
    this.accounts = this.accountActivity.guard(this.accounts, (key, args) =>
      [
        "openLogin",
        "open",
        "refresh",
        ...(dependencies.taskStore ? [] : ["refreshProfile"]),
        "verify",
        "verifyByExternalIdentity",
        "remove",
      ].includes(String(key))
        ? requestAccount(args)
        : undefined,
    );
    this.publications = this.accountActivity.guard(
      this.publications,
      (key, args) => {
        if (
          ["prepare", "prepareRemote", "registerLocalMedia"].includes(
            String(key),
          )
        )
          return dependencies.taskStore && key !== "registerLocalMedia"
            ? undefined
            : requestAccount(args);
        if (key === "openReview") {
          const request = args[0] as { publicationId: string };
          return this.publishing.getTask(request.publicationId)?.accountId;
        }
        return undefined;
      },
    );
    this.platformContents = this.accountActivity.guard(
      this.platformContents,
      (key, args) =>
        dependencies.taskStore
          ? undefined
          : key === "refresh"
            ? String(args[0])
            : key === "refreshByExternalIdentity"
              ? requestAccount(args)
              : undefined,
    );
    this.accounts = this.commands.guard(this.accounts);
    this.publications = this.commands.guard(this.publications);
    this.publicationPlatformContent = this.commands.guard({
      get: this.publicationPlatformContent,
    }).get;
    this.platformContents = this.commands.guard(this.platformContents);
  }

  acquireAccountBrowserSwitch(accountId: string): () => void {
    this.commands.assertRunning();
    if (
      this.publicationBusy(accountId) ||
      this.accountApplication.hasActiveOperation(accountId) ||
      !!this.coordinator?.scheduler.isBusy(accountId)
    )
      throw new Error("账号正在识别或刷新身份，请稍后再切换");
    return this.accountActivity.acquireSwitch(accountId);
  }

  startScheduling(): void {
    this.coordinator?.scheduler.start();
  }

  setRuntimeTaskAccess(allowed: (accountId: string) => boolean): void {
    this.coordinator?.setRuntimeAccess(allowed);
  }

  revokeRuntimeTasks(accountId: string): void {
    this.coordinator?.scheduler.cancelRuntime(accountId);
  }

  freezeForUpdate(): () => void {
    if (this.coordinator?.scheduler.hasOccupied())
      throw new Error("存在活动任务，请先完成后再安装");
    if (this.accountActivity.hasAnySwitch())
      throw new Error("请先完成或取消账号环境切换");
    const resumeDispatch = this.coordinator?.scheduler.pauseDispatch();
    try {
      const resumeCommands = this.commands.freezeForUpdate();
      return () => {
        resumeCommands();
        resumeDispatch?.();
      };
    } catch (error) {
      resumeDispatch?.();
      throw error;
    }
  }

  async stopCommands(): Promise<void> {
    // Freeze public commands synchronously before draining worker executions.
    const commandsStopped = this.commands.stop();
    await this.coordinator?.stop();
    await commandsStopped;
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
          samePlatform(this.platforms, item.platformId, task.platformId) &&
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
      const { mediaReferences, settings, ...textInputs } = inputs;
      const workflowInputs: WorkflowInputs = {
        ...textInputs,
        ...Object.fromEntries(
          Object.entries(settings ?? {}).map(([key, value]) => [
            `settings.${key}`,
            value,
          ]),
        ),
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
