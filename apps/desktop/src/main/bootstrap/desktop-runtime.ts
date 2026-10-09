import { randomUUID } from "node:crypto";
import { release as operatingSystemRelease } from "node:os";
import path from "node:path";

import type { AccountRepository } from "@nedia-matrix/account-management";
import type { PublicationRepository } from "@nedia-matrix/publishing";
import {
  JsonlDiagnosticStore,
  type DiagnosticTrace,
} from "@nedia-matrix/diagnostics";
import {
  AccountPublicationLock,
  PublishingService,
  toPublishResultUpdate,
} from "@nedia-matrix/publishing";
import { app, dialog } from "electron";
import { openDesktopMetadata } from "../persistence/open-desktop-metadata.js";
import { DesktopDiagnosticTraceService } from "../diagnostics/desktop-diagnostic-trace-service.js";
import { registerDiagnosticIpc } from "../diagnostics/ipc/register-diagnostic-ipc.js";
import type { PublicationObservationInbox } from "../publishing/observations/publication-observation-inbox.js";

import { cleanupClosedBrowserSession } from "../accounts/application/account-resource-cleanup.js";
import { PlaywrightBrowserSessionHost } from "../accounts/infrastructure/playwright-browser-session-host.js";
import { registerAccountIpcHandlers } from "../accounts/ipc/register-account-ipc-handlers.js";
import {
  NediaMatrixApplication,
  type DesktopEventSink,
} from "../application/nedia-matrix-application.js";
import { desktopPlatformCatalog } from "../platforms/platform-registry.js";
import { runtimeSupportedTargets } from "../runtime-api/mapping/runtime-supported-targets.js";
import { ContentAddressedPublicationAssetStore } from "../publishing/infrastructure/content-addressed-asset-store.js";
import { MediaSelectionStore } from "../publishing/infrastructure/media-selection-store.js";
import { RemoteAssetDownloader } from "../publishing/infrastructure/remote-asset-downloader.js";
import { registerPublicationIpcHandlers } from "../publishing/ipc/register-publication-ipc-handlers.js";
import { registerPlatformContentIpcHandlers } from "../platform-content/ipc/register-platform-content-ipc-handlers.js";
import { PublicationObservationQueue } from "../publishing/observations/publication-observation-queue.js";
import { PublishObservationManager } from "../publishing/observations/publish-observation-manager.js";
import {
  LocalRuntimeHttpServer,
  readLocalRuntimePort,
} from "../runtime-api/http/local-runtime-http-server.js";
import { registerRuntimeStatusIpcHandler } from "../runtime-api/ipc/register-runtime-status-ipc.js";
import { installApplicationMenu } from "../shell/menu/application-menu.js";
import { NEDIA_MATRIX_PROTOCOL } from "../shell/protocol/custom-protocol.js";
import { ApplicationTray } from "../shell/tray/application-tray.js";
import { ElectronMainWindow } from "../shell/window/electron-main-window.js";
import {
  checkForApplicationUpdateNow,
  getApplicationUpdateState,
  downloadApplicationUpdate,
  cancelApplicationUpdateDownload,
  showApplicationUpdateFile,
  installApplicationUpdate,
  configureUpdateInstallation,
  recordApplicationUpdateStartup,
  openApplicationUpdateDownload,
} from "../updates/electron-application-update.js";
import { registerApplicationUpdateIpcHandler } from "../updates/register-application-update-ipc.js";
import { configuredUpdateSource } from "../updates/application-update.js";
import { completeUpdateExit } from "./update-exit.js";
import { ApplicationLifecycle } from "./application-lifecycle.js";
import { shutdownDesktopRuntime, waitForShutdown } from "./runtime-cleanup.js";

import { ElectronAutomationNotices } from "../shell/notifications/electron-automation-notices.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;
const OBSERVATION_RETRY_INTERVAL_MS = 5_000;
let startupFailureDiagnostics: Promise<void> | undefined;

export function flushStartupFailureDiagnostics(): Promise<void> {
  return startupFailureDiagnostics ?? Promise.resolve();
}

export class DesktopRuntime {
  private readonly accountStore: AccountRepository;
  private readonly metadata: ReturnType<typeof openDesktopMetadata>;
  private readonly accountPublications = new AccountPublicationLock();
  private readonly mediaSelections = new MediaSelectionStore();
  private readonly mainWindow = new ElectronMainWindow(
    (error) => {
      const trace = this.diagnostics.start({
        operation: "application.window_load",
        requestId: randomUUID(),
      });
      trace.report({
        component: "application",
        event: "application.window_load.failed",
        level: "error",
        details: {
          code: "WINDOW_LOAD_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load desktop window",
        },
      });
      trace.finish({ outcome: "failed" });
    },
    () => {
      if (this.startupStage === "completed")
        void recordApplicationUpdateStartup(true).catch((error: unknown) => {
          console.error(
            "Failed to confirm update startup; installation evidence was retained",
            error,
          );
        });
    },
  );
  private readonly publicationRepository: PublicationRepository;
  private readonly publicationObservationInbox: PublicationObservationInbox;
  private readonly publishing: PublishingService;
  private readonly lifecycle = new ApplicationLifecycle();
  private readonly publicationObservations: PublicationObservationQueue;
  private readonly publishObservations: PublishObservationManager;
  private readonly browserSessions: PlaywrightBrowserSessionHost;
  private readonly diagnostics: DesktopDiagnosticTraceService;
  private readonly startupTrace: ReturnType<
    DesktopDiagnosticTraceService["start"]
  >;

  private application: NediaMatrixApplication | undefined;
  private applicationTray: ApplicationTray | undefined;
  private localRuntimeServer: LocalRuntimeHttpServer | null = null;
  private publicationRetryTimer: ReturnType<typeof setInterval> | undefined;
  private readonly observationRetryTraces = new Map<
    string,
    { trace: DiagnosticTrace; attempt: number }
  >();
  private quitAllowed = false;
  private updateInstallInProgress = false;
  private updateCleanupFailed = false;
  private startupStage = "initialize_services";

  constructor() {
    const userDataDirectory = app.getPath("userData");
    const diagnosticRoot = path.join(userDataDirectory, "diagnostics");
    let traceService: DesktopDiagnosticTraceService | undefined;
    const diagnosticStore = new JsonlDiagnosticStore({
      directory: path.join(diagnosticRoot, "logs"),
      evidenceDirectory: path.join(diagnosticRoot, "evidence"),
      legacyDirectories: [path.join(userDataDirectory, "automation-logs")],
      legacyEvidenceDirectory: path.join(
        userDataDirectory,
        "automation-evidence",
      ),
      protectedTraceIds: () => traceService?.activeTraceIds() ?? new Set(),
      onRecordsDropped: (traceId, counts) =>
        traceService?.reportDroppedRecords(traceId, counts),
      onError: (error) =>
        console.error(
          "Local diagnostics unavailable",
          error instanceof Error ? error.name : "UnknownError",
        ),
      ...(!app.isPackaged
        ? {
            onUnknownDetailKeys: (keys: readonly string[]) =>
              console.warn(
                `Diagnostic detail keys were dropped: ${keys.join(", ")}`,
              ),
          }
        : {}),
    });
    traceService = new DesktopDiagnosticTraceService(diagnosticStore);
    this.diagnostics = traceService;
    this.startupTrace = traceService.start({
      operation: "application.startup",
      environment: {
        appVersion:
          typeof app.getVersion === "function" ? app.getVersion() : "unknown",
        operatingSystem: process.platform,
        operatingSystemVersion: operatingSystemRelease(),
        architecture: process.arch,
      },
    });
    this.startupTrace.report({
      component: "logger",
      event: "application.startup.diagnostics_ready",
    });
    this.startupTrace.report({
      component: "persistence",
      event: "persistence.sqlite.open_started",
    });
    try {
      this.metadata = openDesktopMetadata(userDataDirectory, {
        report: (event, details) =>
          this.startupTrace.report({
            component: "persistence",
            event,
            ...(details ? { details } : {}),
          }),
      });
      this.startupTrace.report({
        component: "persistence",
        event: "persistence.sqlite.open_completed",
      });
    } catch (error) {
      this.startupTrace.report({
        component: "persistence",
        event: "persistence.sqlite.open_failed",
        level: "error",
        details: {
          code: "SQLITE_OPEN_FAILED",
          stage: "open_desktop_metadata",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error ? error.message : "Unable to open metadata",
          retryable: false,
        },
      });
      this.startupTrace.finish({
        outcome: "failed",
        message:
          error instanceof Error ? error.message : "Unable to open metadata",
      });
      startupFailureDiagnostics = this.diagnostics.flush();
      throw error;
    }
    this.accountStore = this.metadata.accounts;
    this.publicationRepository = this.metadata.publications;
    this.publicationObservationInbox = this.metadata.inbox;
    this.publishing = new PublishingService(
      this.publicationRepository,
      { now: () => new Date() },
      { create: () => randomUUID() },
    );
    this.publicationObservations = new PublicationObservationQueue(
      {
        recordObservation: (
          publicationId,
          result,
          sequence,
          expectedIdentity,
        ) => {
          if (!this.application) {
            throw new Error("Application is not initialized");
          }
          return this.publishing.recordObservation(
            publicationId,
            result,
            sequence,
            expectedIdentity,
          );
        },
      },
      this.publicationObservationInbox,
      (event) => {
        this.mainWindow.sendPublishResult(toPublishResultUpdate(event));
        this.localRuntimeServer?.publishPublicationUpdate(event.publicationId);
      },
      (event) => {
        this.mainWindow.sendPublishResult({
          ...toPublishResultUpdate(event),
          status: "uncertain",
          message:
            "平台结果已捕获，但本地发布历史保存失败，正在重试；请勿重复发布",
        });
        try {
          let state = this.observationRetryTraces.get(event.eventId);
          if (!state) {
            const trace = this.diagnostics.start({
              operation: "publication.observation.persist",
              requestId: event.eventId,
              accountId: event.accountId,
              platformId: event.platformId,
            });
            trace.bind({ publicationId: event.publicationId });
            state = { trace, attempt: 0 };
            this.observationRetryTraces.set(event.eventId, state);
          }
          state.trace.report({
            component: "persistence",
            event: "publication.observation.persist_deferred",
            level: "warn",
            details: { code: "OBSERVATION_PERSIST_DEFERRED", retryable: true },
          });
        } catch {
          // Diagnostics must not change observation persistence behavior.
        }
      },
      (error) =>
        console.error(
          "Failed to persist publish observation",
          error instanceof Error ? error.name : "UnknownError",
        ),
      (operation) => this.metadata.database.transaction(operation),
      {
        onRetryStarted: (event) => {
          let state = this.observationRetryTraces.get(event.eventId);
          if (!state) {
            const trace = this.diagnostics.start({
              operation: "publication.observation.persist",
              requestId: event.eventId,
              accountId: event.accountId,
              platformId: event.platformId,
            });
            trace.bind({ publicationId: event.publicationId });
            state = { trace, attempt: 0 };
            this.observationRetryTraces.set(event.eventId, state);
          }
          state.attempt += 1;
          state.trace.report({
            component: "persistence",
            event: "publication.observation.retry_started",
            details: { attempt: state.attempt },
          });
        },
        onRetrySucceeded: (event) => {
          const state = this.observationRetryTraces.get(event.eventId);
          if (!state) return;
          state.trace.report({
            component: "persistence",
            event: "publication.observation.retry_completed",
            details: { attempt: state.attempt },
          });
          state.trace.finish({ outcome: "completed" });
          this.observationRetryTraces.delete(event.eventId);
        },
        onRetryFailed: (event, error) => {
          const state = this.observationRetryTraces.get(event.eventId);
          state?.trace.report({
            component: "persistence",
            event: "publication.observation.retry_failed",
            level: "warn",
            details: {
              attempt: state.attempt,
              code: "OBSERVATION_PERSIST_FAILED",
              errorName: error instanceof Error ? error.name : "UnknownError",
              message:
                error instanceof Error
                  ? error.message
                  : "Unable to persist publication observation",
              retryable: true,
            },
          });
        },
      },
    );
    this.publishObservations = new PublishObservationManager((event) => {
      return this.publicationObservations.accept(event);
    });
    this.browserSessions = new PlaywrightBrowserSessionHost(
      (accountId) => {
        cleanupClosedBrowserSession(accountId, {
          mediaSelections: this.mediaSelections,
          publishObservations: this.publishObservations,
        });
      },
      undefined,
      () => {
        void dialog.showMessageBox({
          type: "info",
          title: "发布页面已打开新标签页",
          message:
            "请在原发布页完成提交。新标签页中的提交不属于当前任务的结果观察范围；如已在新标签页提交，请先核实平台结果，不要重复发布。",
        });
      },
    );
  }

  get canQuit(): boolean {
    return this.quitAllowed;
  }

  start(): void {
    try {
      this.startServices();
    } catch (error) {
      this.startupTrace.report({
        component: "application",
        event: "application.startup.failed",
        level: "error",
        details: {
          code: "STARTUP_FAILED",
          stage: this.startupStage,
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error
              ? error.message
              : "Unable to start desktop runtime",
        },
      });
      this.startupTrace.finish({ outcome: "failed" });
      startupFailureDiagnostics = this.diagnostics.flush();
      throw error;
    }
  }

  private startServices(): void {
    const report = this.metadata.importReport;
    if (report && (report.missingAssets || report.missingActiveProfiles)) {
      dialog.showErrorBox(
        "本地历史资源缺失",
        `元数据已导入，检测到 ${report.missingAssets} 个素材引用和 ${report.missingActiveProfiles} 个已确认账号的浏览器目录缺失。历史记录已保留；账号可能需要重新登录，缺失素材不会自动下载或重新发布。`,
      );
    }
    const publicationAssetStore = new ContentAddressedPublicationAssetStore(
      path.join(app.getPath("userData"), "assets"),
    );
    const remoteAssets = new RemoteAssetDownloader({
      assetStore: publicationAssetStore,
      stagingRoot: path.join(app.getPath("userData"), "staging"),
      diagnostics: this.diagnostics,
    });
    const dependencies = {
      platforms: desktopPlatformCatalog,
      runtime: {
        status: () =>
          this.localRuntimeServer?.status() ?? {
            status: "stopped" as const,
            version: app.getVersion(),
            host: "127.0.0.1" as const,
            port: null,
          },
        setRunning: async (request: { running: boolean }) => {
          const server = this.localRuntimeServer;
          if (!server) throw new Error("Local runtime is not initialized");
          if (request.running) await server.start();
          else await server.stop();
          return server.status();
        },
      },
      updates: {
        state: getApplicationUpdateState,
        cancelDownload: cancelApplicationUpdateDownload,
        showFile: showApplicationUpdateFile,
        install: installApplicationUpdate,
        download: async () => {
          const trace = this.diagnostics.start({
            operation: "application.update",
            requestId: randomUUID(),
          });
          try {
            const download = downloadApplicationUpdate();
            const started = getApplicationUpdateState();
            trace.report({
              component: "network",
              event: "application.update.download_started",
              details: {
                source: configuredUpdateSource(),
                taskId: started.taskId,
                version: started.latestVersion,
              },
            });
            await download;
            const state = getApplicationUpdateState();
            trace.report({
              component: "network",
              event:
                state.phase === "ready"
                  ? "application.update.download_completed"
                  : "application.update.download_cancelled",
              details: {
                source: configuredUpdateSource(),
                phase: state.phase,
                taskId: state.taskId,
                version: state.latestVersion,
                receivedBytes: state.receivedBytes,
              },
            });
            trace.finish({ outcome: "completed" });
          } catch (error) {
            const state = getApplicationUpdateState();
            trace.report({
              component: "network",
              event: "application.update.download_failed",
              level: "error",
              details: {
                source: configuredUpdateSource(),
                code: "UPDATE_DOWNLOAD_FAILED",
                taskId: state.taskId,
                version: state.latestVersion,
                message: state.error?.message ?? "Download failed",
                retryable: true,
              },
            });
            trace.finish({ outcome: "failed" });
            throw error;
          }
        },
        check: async () => {
          const trace = this.diagnostics.start({
            operation: "application.update",
            requestId: randomUUID(),
          });
          trace.report({
            component: "network",
            event: "application.update.check_started",
          });
          try {
            const result = await checkForApplicationUpdateNow();
            trace.report({
              component: "network",
              event: "application.update.check_completed",
              details: {
                decision: result.status,
                currentVersion: result.currentVersion,
                ...(result.status === "update-available"
                  ? { latestVersion: result.latestVersion }
                  : {}),
              },
            });
            trace.finish({ outcome: "completed" });
            return result;
          } catch (error) {
            trace.report({
              component: "network",
              event: "application.update.check_failed",
              level: "error",
              details: {
                code: "UPDATE_CHECK_FAILED",
                errorName: error instanceof Error ? error.name : "UnknownError",
                message:
                  error instanceof Error
                    ? error.message
                    : "Update check failed",
                retryable: true,
              },
            });
            trace.finish({ outcome: "failed" });
            throw error;
          }
        },
        openDownload: async (request: { version: string }) => {
          const trace = this.diagnostics.start({
            operation: "application.update",
            requestId: randomUUID(),
          });
          try {
            await openApplicationUpdateDownload(request.version);
            trace.report({
              component: "shell",
              event: "application.update.download_handoff_completed",
              details: { version: request.version },
            });
            trace.finish({ outcome: "completed" });
          } catch (error) {
            trace.report({
              component: "shell",
              event: "application.update.download_handoff_failed",
              level: "error",
              details: {
                code: "UPDATE_HANDOFF_FAILED",
                errorName: error instanceof Error ? error.name : "UnknownError",
                message:
                  error instanceof Error
                    ? error.message
                    : "Update download handoff failed",
                retryable: true,
              },
            });
            trace.finish({ outcome: "failed" });
            throw error;
          }
        },
      },
      notices: new ElectronAutomationNotices(
        async (accountId) => {
          const account = this.accountStore.get(accountId);
          if (!account) return;
          const lease = this.accountPublications.acquire(accountId);
          if (!lease) throw new Error("Account has an active publication");
          try {
            await this.browserSessions.closeAutomation(account);
          } finally {
            lease.release();
          }
        },
        (notice, event, error) => {
          const trace = this.diagnostics.start({
            operation: "automation.notice",
            accountId: notice.accountId,
            ...(notice.kind.startsWith("publish.") &&
            "publicationId" in notice &&
            notice.publicationId
              ? { requestId: notice.publicationId }
              : {}),
          });
          if ("publicationId" in notice && notice.publicationId) {
            trace.bind({ publicationId: notice.publicationId });
          }
          trace.report({
            component: "shell",
            event,
            level: event === "notice.failed" ? "error" : "info",
            details: {
              kind: notice.kind,
              ...(error instanceof Error ? { errorName: error.name } : {}),
            },
          });
          trace.finish({
            outcome: event === "notice.failed" ? "failed" : "completed",
          });
        },
      ),
      automationDiagnostics: this.diagnostics,
      archiveDiagnostics: {
        report: ({
          event,
          details,
        }: {
          event: string;
          details: Readonly<Record<string, unknown>>;
        }) => {
          const trace = this.diagnostics.start({
            operation: "publication.archive.cleanup",
          });
          trace.report({
            component: "application",
            event,
            level: "warn",
            details,
          });
          trace.finish({ outcome: "partial_failure" });
        },
      },
      accountPublications: this.accountPublications,
      accountStore: this.accountStore,
      platformContents: this.metadata.platformContents,
      browserSessions: this.browserSessions,
      mediaSelections: this.mediaSelections,
      publishObservations: this.publishObservations,
      publishing: this.publishing,
      publicationArchive: this.metadata.publications,
      publicationSelection: this.metadata.publications,
      publicationAttention: this.metadata.publicationAttention,
      publicationQuery: this.metadata.publications,
      publicationArchiveAssets: publicationAssetStore,
      remoteAssets,
      removeAccountResources: async (
        account: Parameters<PlaywrightBrowserSessionHost["remove"]>[0],
      ) => {
        const trace = this.diagnostics.start({
          operation: "resource.delete",
          accountId: account.id,
          platformId: account.platformId,
          requestId: randomUUID(),
        });
        const lease = this.accountPublications.acquire(account.id);
        if (!lease) {
          trace.report({
            component: "application",
            event: "resource.delete.lease_rejected",
            level: "warn",
            details: { code: "ACCOUNT_BUSY", retryable: true },
          });
          trace.finish({ outcome: "account_busy" });
          throw new Error("Account has an active publication");
        }
        try {
          trace.report({
            component: "application",
            event: "resource.delete.started",
          });
          await this.publishObservations.stop(account.id);
          await this.browserSessions.closeAutomation(account);
          this.metadata.accounts.removeWithProfileIntent(account.id);
          trace.report({
            component: "persistence",
            event: "resource.delete.intent_persisted",
          });
          this.mediaSelections.removeForAccount(account.id);
          this.mainWindow.sendAccountsChanged();
          this.localRuntimeServer?.publishAccountsChanged();
          try {
            if (this.accountStore.hasProfileReference(account.profileId))
              throw new Error("Profile is still referenced");
            await this.browserSessions.removeProfile(account.profileId);
            this.accountStore.discardRetiredProfile(account.profileId);
            trace.report({
              component: "browser",
              event: "resource.delete.profile_removed",
            });
            trace.finish({ outcome: "completed" });
          } catch (error) {
            trace.report({
              component: "browser",
              event: "resource.delete.profile_remove_failed",
              level: "error",
              details: {
                code: "PROFILE_REMOVE_FAILED",
                errorName: error instanceof Error ? error.name : "UnknownError",
                message:
                  error instanceof Error
                    ? error.message
                    : "Unable to remove browser profile",
                retryable: true,
              },
            });
            trace.finish({
              outcome: "cleanup_pending",
              message: "Browser profile cleanup is pending",
            });
            throw new Error(
              "账号已删除，浏览器资源清理待重试；下次启动将继续清理",
            );
          }
        } finally {
          lease.release();
        }
      },
      eventSink: {
        publish: (event) => {
          if (event.type === "accounts.changed") {
            this.mainWindow.sendAccountsChanged();
            this.localRuntimeServer?.publishAccountsChanged();
          }
        },
      } satisfies DesktopEventSink,
    };
    this.application = new NediaMatrixApplication(dependencies);
    this.startupStage = "replay_publication_observations";
    this.publicationObservations.replayPersisted();
    this.startupStage = "recover_interrupted_publications";
    this.application.publications.recoverInterrupted();
    this.startupStage = "register_services";
    void this.application.accounts.cleanupRetiredProfiles().catch(() => {
      console.error("Failed to clean up retired browser profiles");
    });
    registerAccountIpcHandlers(this.application);
    registerPlatformContentIpcHandlers(this.application);
    registerPublicationIpcHandlers({
      ...dependencies,
      application: this.application,
    });
    configureUpdateInstallation({
      acquire: () => {
        if (
          this.updateInstallInProgress ||
          this.lifecycle.requestWindowOpen() !== "open-now" ||
          this.accountPublications.hasAnyActive() ||
          this.publishObservations.hasActive()
        )
          throw new Error("存在活动发布或正在退出，请先完成任务再安装");
        this.publicationObservations.retryPending();
        if (this.publicationObservations.pendingCount > 0)
          throw new Error("发布结果尚未持久化，请稍后重试安装");
        const resume = this.application!.freezeForUpdate();
        this.updateInstallInProgress = true;
        return () => {
          this.updateInstallInProgress = false;
          resume();
        };
      },
      finish: async (prepared) => {
        if (!this.lifecycle.beginShutdown())
          throw new Error("应用已进入退出流程");
        if (this.publicationRetryTimer)
          clearInterval(this.publicationRetryTimer);
        try {
          await completeUpdateExit(prepared, {
            cleanup: async () => {
              await this.localRuntimeServer?.stop();
              await this.publishObservations.stopAll();
              this.publicationObservations.retryPending();
              if (this.publicationObservations.pendingCount > 0)
                throw new Error("发布结果持久化失败");
              this.mediaSelections.clear();
              await this.browserSessions.closeAll();
              await this.diagnostics.flush();
              await this.diagnostics.close();
            },
            closeDatabase: () => this.metadata.database.close(),
            exit: () => {
              this.applicationTray?.destroy();
              this.quitAllowed = true;
              app.exit(0);
            },
          });
        } catch (error) {
          await prepared.cancel();
          this.updateCleanupFailed = true;
          throw new Error(
            `${error instanceof Error ? error.message : "更新退出失败"}；安装已停止，业务入口已关闭，请退出并重新启动应用。`,
          );
        }
      },
    });
    registerApplicationUpdateIpcHandler(this.application);
    registerDiagnosticIpc({
      logDirectory: path.join(app.getPath("userData"), "diagnostics"),
      evidenceDirectories: [
        path.join(app.getPath("userData"), "diagnostics", "evidence"),
        path.join(app.getPath("userData"), "automation-evidence"),
      ],
      findTraceForPublication: (publicationId) =>
        this.diagnostics.findTraceForPublication(publicationId),
      readTrace: (traceId, limit, afterSequence) =>
        this.diagnostics.readTrace(traceId, limit, afterSequence),
    });

    this.registerCustomProtocol();
    this.localRuntimeServer = this.createLocalRuntimeServer(this.application);
    registerRuntimeStatusIpcHandler(this.application);
    const runtimeTrace = this.diagnostics.start({
      operation: "runtime.listen",
      requestId: randomUUID(),
    });
    void this.localRuntimeServer.start().then(
      () => {
        runtimeTrace.report({
          component: "runtime",
          event: "runtime.listen.completed",
        });
        runtimeTrace.finish({ outcome: "completed" });
      },
      (error: unknown) => {
        runtimeTrace.report({
          component: "runtime",
          event: "runtime.listen.failed",
          level: "error",
          details: {
            code: "RUNTIME_LISTEN_FAILED",
            errorName: error instanceof Error ? error.name : "UnknownError",
            message:
              error instanceof Error
                ? error.message
                : "Unable to start local runtime server",
          },
        });
        runtimeTrace.finish({ outcome: "failed" });
        console.error("Failed to start local runtime server", error);
      },
    );

    installApplicationMenu({ quitApplication: () => this.requestQuit() });
    this.applicationTray = new ApplicationTray({
      openMainWindow: () => this.openMainWindow(),
      quitApplication: () => this.requestQuit(),
    });
    this.publicationRetryTimer = setInterval(
      () => this.publicationObservations.retryPending(),
      OBSERVATION_RETRY_INTERVAL_MS,
    );
    this.publicationRetryTimer.unref();
    this.startupTrace.report({
      component: "application",
      event: "application.startup.services_registered",
    });
    this.startupTrace.finish({ outcome: "completed" });
    this.startupStage = "completed";
  }

  openMainWindow(): void {
    if (this.lifecycle.requestWindowOpen() === "ignore-during-shutdown") return;
    if (process.platform === "darwin") {
      const dock = app.dock;
      if (dock && !dock.isVisible()) {
        void dock.show().catch((error: unknown) => {
          console.error("Failed to show the application in the Dock", error);
        });
      }
    }
    this.mainWindow.open();
  }

  requestQuit(): void {
    if (this.updateCleanupFailed) {
      // No installation permit was submitted. Exit without closing a possibly busy database.
      app.exit(1);
      return;
    }
    if (this.updateInstallInProgress) return;
    if (!this.lifecycle.beginShutdown()) return;
    // Abort network work before draining the application command gate.
    void cancelApplicationUpdateDownload();
    const shutdownTrace = this.diagnostics.start({
      operation: "application.shutdown",
      requestId: randomUUID(),
    });
    this.publicationObservations.retryPending();
    const shutdown = Promise.all([
      (this.application?.stopCommands() ?? Promise.resolve()).then(() =>
        shutdownDesktopRuntime({
          browserSessions: this.browserSessions,
          mediaSelections: this.mediaSelections,
          publishObservations: this.publishObservations,
          diagnostics: this.diagnostics,
          report: (event, details) =>
            shutdownTrace.report({
              component: "application",
              event,
              ...(details ? { details } : {}),
            }),
          finishDiagnostics: (result) => shutdownTrace.finish(result),
        }),
      ),
      this.localRuntimeServer?.stop(),
    ]).then(() => undefined);

    void waitForShutdown(shutdown, SHUTDOWN_TIMEOUT_MS)
      .then((result) => {
        if (result === "timed-out") {
          console.warn(
            `Desktop shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; quitting without waiting for remaining cleanup`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to cleanly shut down desktop runtime", error);
      })
      .finally(() => {
        if (this.publicationRetryTimer)
          clearInterval(this.publicationRetryTimer);
        this.applicationTray?.destroy();
        this.quitAllowed = true;
        // Exit synchronously after closing: no async cleanup callback may run
        // against the closed connection. Interrupted work recovers next launch.
        this.metadata.database.close();
        app.exit(0);
      });
  }

  private registerCustomProtocol(): void {
    const registered =
      process.defaultApp && process.argv[1]
        ? app.setAsDefaultProtocolClient(
            NEDIA_MATRIX_PROTOCOL,
            process.execPath,
            [path.resolve(process.argv[1])],
          )
        : app.setAsDefaultProtocolClient(NEDIA_MATRIX_PROTOCOL);
    if (!registered) {
      console.warn("Failed to register nedia-matrix protocol handler");
    }
  }

  private createLocalRuntimeServer(
    application: NediaMatrixApplication,
  ): LocalRuntimeHttpServer {
    return new LocalRuntimeHttpServer({
      application,
      diagnostics: this.diagnostics,
      port: readLocalRuntimePort(process.env.MATRIX_RUNTIME_PORT),
      handshake: {
        protocolVersion: 1,
        runtimeKind: "desktop_playwright",
        runtimeVersion: app.getVersion(),
        instanceId: randomUUID(),
        supportedTargets: runtimeSupportedTargets(
          application.platformSummaries(),
        ),
        capabilities: {
          isolatedAccounts: true,
          multipleAccountsPerPlatform: true,
          backgroundObservation: true,
          localPublicationArchive: true,
          platformIdentityAddressing: true,
          platformContentSnapshots: true,
          platformContentSync: true,
        },
      },
    });
  }
}
