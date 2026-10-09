import { describe, expect, it, vi } from "vitest";

import {
  AccountPublicationLock,
  MediaSelectionUnavailableError,
  type StartPublicationInput,
} from "@nedia-matrix/publishing";
import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import type { PublishResultEvent } from "@nedia-matrix/platform-sdk";

import { RuntimeAccountRoutes } from "../src/main/runtime-api/http/routes/account-routes.js";

import { NediaMatrixApplication } from "../src/main/application/nedia-matrix-application.js";
import { desktopPlatformRegistry } from "../src/main/platforms/platform-registry.js";

function createDependencies() {
  const accounts = new Map<string, PlatformAccountSnapshot>();
  const accountUpdates: number[] = [];
  return {
    accounts,
    accountUpdates,
    dependencies: {
      platforms: desktopPlatformRegistry,
      runtime: {
        status: () => ({
          status: "stopped" as const,
          version: "test",
          host: "127.0.0.1" as const,
          port: null,
        }),
        setRunning: async () => ({
          status: "stopped" as const,
          version: "test",
          host: "127.0.0.1" as const,
          port: null,
        }),
      },
      updates: {
        state: () => ({
          revision: 0,
          phase: "idle" as const,
          currentVersion: "test",
          downloadAvailable: false,
          receivedBytes: 0,
          totalBytes: 0,
        }),
        download: async () => undefined,
        cancelDownload: async () => undefined,
        install: async () => undefined,
        showFile: async () => undefined,
        check: async () => ({
          status: "up-to-date" as const,
          currentVersion: "test",
        }),
        openDownload: async () => undefined,
      },
      removeAccountResources: async (account: PlatformAccountSnapshot) => {
        accounts.delete(account.id);
      },
      accountPublications: new AccountPublicationLock(),
      accountStore: {
        list: () => [...accounts.values()],
        get: (accountId: string) => accounts.get(accountId),
        require: (accountId: string) => {
          const account = accounts.get(accountId);
          if (!account) throw new TypeError("Platform account does not exist");
          return account;
        },
        resolve: (accountId: string) => {
          const account = accounts.get(accountId);
          if (!account) throw new TypeError("Platform account does not exist");
          return { account };
        },
        findActiveByIdentity: (identity: {
          platformId: string;
          identityScheme: string;
          externalAccountId: string;
        }) =>
          [...accounts.values()].filter(
            (account) =>
              account.lifecycle === "active" &&
              account.platformId === identity.platformId &&
              account.identityScheme === identity.identityScheme &&
              account.externalAccountId === identity.externalAccountId,
          ),
        put: (account: PlatformAccountSnapshot) =>
          accounts.set(account.id, account),
        remove: (accountId: string) => {
          accounts.delete(accountId);
        },
      },
      platformContents: {
        listByAccount: () => [],
        findMany: () => [],
        find: () => undefined,
        saveAll: () => undefined,
        saveRun: () => undefined,
        latestRun: () => undefined,
      },
      browserSessions: {
        openForLogin: async () => undefined,
        openUserPage: async () => {
          throw new Error("not used");
        },
        closeAutomation: async () => undefined,
        remove: async () => undefined,
      },
      mediaSelections: {
        create: () => {
          throw new Error("not used");
        },
        consume: () => undefined,
        removeForAccount: () => undefined,
        acquire: () => {
          throw new Error("not used");
        },
        release: () => undefined,
      },
      publishObservations: {
        attach: () => {
          throw new Error("not used");
        },
        stop: () => undefined,
      },
      remoteAssets: {
        download: async () => {
          throw new Error("not used");
        },
        discardUnreferenced: async () => {
          throw new Error("not used");
        },
      },
      publishing: {
        get: () => undefined,
        list: () => [],
        markAwaitingConfirmation: () => {
          throw new Error("not used");
        },
        markPreparationFailed: () => {
          throw new Error("not used");
        },
        markSubmissionUncertain: () => {
          throw new Error("not used");
        },
        markSubmitting: () => {
          throw new Error("not used");
        },
        startPreparation: () => {
          throw new Error("not used");
        },
      },
      createId: () => "account-1",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      eventSink: {
        publish: (event: { type: string }) => {
          if (event.type === "accounts.changed") accountUpdates.push(1);
        },
      },
    },
  };
}

function createPublishFixture(options?: {
  detectedExternalAccountId?: string;
  existingPublication?: boolean;
  failSubmit?: boolean;
  failPreparation?: boolean;
  publishDuringPreparation?: boolean;
  verifyDuringPreparation?: boolean;
  loginRequired?: boolean;
  mediaSelectionUnavailable?: boolean;
  platformId?: "douyin" | "kuaishou";
  contentForm?: "imageText" | "video";
}) {
  const { accounts, accountUpdates, dependencies: base } = createDependencies();
  accounts.set("account-1", {
    id: "account-1",
    platformId: options?.platformId ?? "douyin",
    profileId: `matrix-${options?.platformId ?? "douyin"}-account-1`,
    lifecycle: "active",
    displayName: options?.platformId === "kuaishou" ? "快手账号" : "抖音账号",
    identityScheme:
      options?.platformId === "kuaishou"
        ? "kuaishou.user_id"
        : "douyin.short_id",
    externalAccountId: "external-1",
    nickname: "测试账号",
    avatarUrl: null,
    accountInfo: [],
    profileSyncedAt: null,
    status: "authenticated",
    lastVerifiedAt: "2026-08-10T00:00:00.000Z",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  });
  const actions: string[] = [];
  let preparationInput: StartPublicationInput | undefined;
  let prepareWorkflowInputs: Readonly<Record<string, unknown>> | undefined;
  let publicationState = "preparing";
  let observationArmed = false;
  let publicationStarted = options?.existingPublication ?? false;
  let finishObservation: (
    result?: PublishResultEvent,
  ) => void | Promise<void> = () => undefined;
  let remoteSelection:
    | {
        resourceReferences: readonly string[];
        files: readonly { name: string; size: number }[];
        inUse: boolean;
      }
    | undefined;
  const publicationRecord = () =>
    ({
      requestId: "request-1",
      publication: { id: "publication-1", state: publicationState },
      assets: [
        {
          localRelativePath:
            "sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        },
      ],
    }) as never;
  const observationSession = {
    responses: { subscribe: () => () => undefined },
    page: {
      isTextVisible: async () => false,
      subscribeClose: () => () => undefined,
    },
  };
  const dependencies = {
    ...base,
    publicationArchiveAssets: {
      list: async () => [],
      remove: async () => undefined,
      resolvePath: async () => "/archive/image.png",
    },
    browserSessions: {
      ...base.browserSessions,
      openUserPage: async () => undefined,
      openForVerification: async () => ({
        driver: {},
        sessionProbeClient: {},
        close: async () => undefined,
      }),
      openForPublication: async () => ({
        id: "session-1",
        profileId: `matrix-${options?.platformId ?? "douyin"}-account-1`,
        driver: {},
        observationSession,
        sessionProbeClient: {},
        focus: async () => actions.push("focus"),
        handoff: async () => actions.push("handoff"),
        verifyIdentity: async () => undefined,
        release: async () => undefined,
      }),
    },
    mediaSelections: {
      ...base.mediaSelections,
      create: (selection: typeof remoteSelection) => {
        actions.push("create-selection");
        remoteSelection = selection;
        return "remote-selection-1";
      },
      acquire: () => {
        if (options?.mediaSelectionUnavailable) {
          throw new MediaSelectionUnavailableError();
        }
        return (
          remoteSelection ?? {
            resourceReferences: [
              options?.contentForm === "video"
                ? "/tmp/video.mp4"
                : "/tmp/image.jpg",
            ],
            files: [
              {
                name:
                  options?.contentForm === "video" ? "video.mp4" : "image.jpg",
                size: 42,
              },
            ],
            accountId: "account-1",
            contentForm: options?.contentForm ?? ("imageText" as const),
            createdAt: 0,
          }
        );
      },
      release: () => actions.push("release"),
      consume: () => actions.push("consume"),
    },
    publishObservations: {
      stop: async () => undefined,
      attach: (input: {
        onFinished?: (result?: PublishResultEvent) => void | Promise<void>;
      }) => {
        finishObservation = input.onFinished ?? (() => undefined);
        return {
          id: "observation-1",
          ready: async () => actions.push("ready"),
          arm: () => {
            observationArmed = true;
            actions.push("arm");
          },
          beginSubmissionAttempt: async () => actions.push("attempt"),
          interrupt: async () => {
            actions.push("stop");
            await finishObservation();
          },
          stopSilently: async () => {
            actions.push("stop");
            await finishObservation();
          },
        };
      },
    },
    publishing: {
      get: () => publicationRecord(),
      list: () => (publicationStarted ? [publicationRecord()] : []),
      startPreparation: (input: StartPublicationInput) => {
        actions.push("start");
        preparationInput = input;
        publicationStarted = true;
        publicationState = "preparing";
        return { record: publicationRecord(), started: true };
      },
      markAwaitingConfirmation: () => {
        actions.push("mark:awaiting_confirmation");
        publicationState = "awaiting_confirmation";
        return publicationRecord();
      },
      markSubmitting: () => {
        actions.push("mark:submitting");
        publicationState = "submitting";
        return publicationRecord();
      },
      markPreparationFailed: () => {
        actions.push("mark:failed");
        publicationState = "failed";
        return publicationRecord();
      },
      markSubmissionUncertain: () => {
        actions.push("mark:uncertain");
        publicationState = "uncertain";
        return publicationRecord();
      },
    },
    remoteAssets: {
      download: async () => {
        actions.push("download");
        return [
          {
            created: true,
            resourceReference: "/archive/image.png",
            hash: "a".repeat(64),
            localRelativePath: `sha256/aa/${"a".repeat(64)}.png`,
            mediaType: "image/png" as const,
            name: "image.png",
            order: 0,
            role: "image" as const,
            size: 42,
            sourceAssetId: "asset-1",
            sourceOrigin: "https://assets.example.test",
            downloadedAt: "2026-08-10T00:00:00.000Z",
          },
        ];
      },
      discardUnreferenced: async () => actions.push("discard"),
    },
    sessionDetector: async () => ({
      ...(options?.loginRequired
        ? { status: "login_required" as const }
        : {
            status: "authenticated" as const,
            identityScheme:
              options?.platformId === "kuaishou"
                ? "kuaishou.user_id"
                : "douyin.short_id",
            externalAccountId:
              options?.detectedExternalAccountId ?? "external-1",
            nickname: "测试账号",
            avatarUrl: null,
            accountInfo: [],
            source: "api" as const,
          }),
    }),
    workflowExecutor: async (
      workflow: { id: string },
      _driver: unknown,
      inputs: Readonly<Record<string, unknown>>,
      hooks?: {
        beforeCommit?: (input: { boundary: "submission" }) => Promise<void>;
      },
    ) => {
      const workflowId = workflow.id;
      if (workflowId === "publish.submit") {
        await hooks?.beforeCommit?.({ boundary: "submission" });
      }
      actions.push(`workflow:${workflowId}`);
      if (workflowId.startsWith("publish.prepare")) {
        prepareWorkflowInputs = inputs;
        if (options?.publishDuringPreparation && observationArmed) {
          publicationState = "published";
          actions.push("observed:published");
        }
        if (options?.verifyDuringPreparation) {
          publicationState = "verifying";
          actions.push("observed:verifying");
        }
        if (options?.failPreparation) {
          throw new Error("editor fill failed");
        }
      }
      if (options?.failSubmit && workflowId === "publish.submit") {
        throw new Error("submit click outcome is unknown");
      }
    },
  };
  return {
    actions,
    accounts,
    accountUpdates,
    dependencies,
    finishObservation: (result?: PublishResultEvent) =>
      finishObservation(result),
    preparationInput: () => preparationInput,
    prepareWorkflowInputs: () => prepareWorkflowInputs,
  };
}

describe("NediaMatrixApplication", () => {
  it("accepts only a work from the publication account snapshot", () => {
    const { dependencies } = createDependencies();
    const candidate = {
      accountId: "account-1",
      platformId: "douyin",
      externalContentId: "work-1",
    };
    const findMany = vi.fn(() => [candidate]);
    const application = new NediaMatrixApplication({
      ...dependencies,
      platformContents: { ...dependencies.platformContents, findMany },
    } as never);
    const publishing = (
      application as unknown as {
        publishing: {
          getTask: (id: string) => unknown;
          selectContent: (id: string, contentId: string) => unknown;
        };
      }
    ).publishing;
    vi.spyOn(publishing, "getTask").mockReturnValue({
      id: "publication-1",
      accountId: "account-1",
      platformId: "douyin",
      state: "published",
    });
    const selectContent = vi
      .spyOn(publishing, "selectContent")
      .mockReturnValue({ id: "publication-1" });

    expect(() =>
      application.publications.selectContent?.("publication-1", "work-1"),
    ).not.toThrow();
    expect(selectContent).toHaveBeenCalledWith("publication-1", "work-1");
    expect(findMany).toHaveBeenCalledWith("account-1", ["work-1"]);

    candidate.accountId = "another-account";
    expect(() =>
      application.publications.selectContent?.("publication-1", "work-1"),
    ).toThrow("not in this account snapshot");
    candidate.accountId = "account-1";
    candidate.platformId = "xiaohongshu";
    expect(() =>
      application.publications.selectContent?.("publication-1", "work-1"),
    ).toThrow("not in this account snapshot");
    expect(selectContent).toHaveBeenCalledTimes(1);
  });

  it("creates an isolated account through a transport-independent use case", () => {
    const { dependencies } = createDependencies();
    const application = new NediaMatrixApplication(dependencies);

    const account = application.accounts.create({ platformId: "douyin" });

    expect(account).toMatchObject({
      id: "account-1",
      platformId: "douyin",
      profileId: "matrix-douyin-account-1",
      status: "login_required",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(application.accounts.list()).toEqual([account]);
  });

  it("delegates account deletion to the injected resource operation", async () => {
    const { accounts, dependencies } = createDependencies();
    const removeAccountResources = vi.fn(dependencies.removeAccountResources);
    const application = new NediaMatrixApplication({
      ...dependencies,
      removeAccountResources,
    });
    const account = application.accounts.create({ platformId: "douyin" });

    await application.accounts.remove({ accountId: account.id });

    expect(removeAccountResources).toHaveBeenCalledExactlyOnceWith(account);
    expect(accounts.has(account.id)).toBe(false);
  });

  it("validates account creation before mutating the store", () => {
    const { accounts, dependencies } = createDependencies();
    const application = new NediaMatrixApplication(dependencies);

    expect(() => application.accounts.create({ platformId: "" })).toThrow(
      "Invalid platform request",
    );
    expect(accounts.size).toBe(0);
  });

  it("persists submitting and arms observation before automatic submit", async () => {
    const { actions, dependencies } = createPublishFixture();
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic",
    });

    expect(result.status).toBe("submission_started");
    expect(actions).toEqual([
      "start",
      "ready",
      "workflow:publish.prepare.imageText",
      "consume",
      "arm",
      "mark:submitting",
      "attempt",
      "workflow:publish.submit",
    ]);
  });

  it("keeps publication behavior when the diagnostic port fails", async () => {
    const { dependencies } = createPublishFixture();
    const application = new NediaMatrixApplication({
      ...dependencies,
      automationDiagnostics: {
        start: () => {
          throw new Error("diagnostics unavailable");
        },
      },
    } as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        submissionMode: "automatic",
      }),
    ).resolves.toMatchObject({ status: "submission_started" });
  });

  it("records a failed publication preflight before the automation lease", async () => {
    const { dependencies } = createPublishFixture();
    const report = vi.fn();
    const finish = vi.fn();
    const start = vi.fn(() => ({
      traceId: "trace-preflight",
      bind: vi.fn(),
      report,
      execution: vi.fn(),
      finish,
    }));
    const application = new NediaMatrixApplication({
      ...dependencies,
      automationDiagnostics: { start },
    } as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        requestId: "request-preflight",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        sourcePublicationId: "missing-source",
        submissionMode: "manual_confirmation",
      }),
    ).rejects.toThrow("Source publication must be terminal");
    expect(start).toHaveBeenCalledWith({
      operation: "publication.prepare",
      requestId: "request-preflight",
      accountId: "account-1",
      platformId: "douyin",
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "publication.preflight.failed",
        details: expect.objectContaining({ stage: "source_publication" }),
      }),
    );
    expect(finish).toHaveBeenCalledWith({ outcome: "failed" });
    expect(dependencies.accountPublications.isActive("account-1")).toBe(false);
  });

  it("does not create an automation trace for malformed publication input", async () => {
    const { dependencies } = createPublishFixture();
    const start = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      automationDiagnostics: { start },
    } as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        requestId: " ",
      }),
    ).rejects.toThrow("Invalid publish draft request");
    expect(start).not.toHaveBeenCalled();
  });

  it("uses one trace with separate prepare and submit executions", async () => {
    const { dependencies } = createPublishFixture();
    const bind = vi.fn();
    const report = vi.fn();
    const execution = vi.fn((phase: string) => ({
      executionId: `execution-${phase}`,
      report: vi.fn(),
    }));
    const start = vi.fn(() => ({
      traceId: "trace-1",
      bind,
      report,
      execution,
      finish: vi.fn(),
    }));
    const application = new NediaMatrixApplication({
      ...dependencies,
      automationDiagnostics: { start },
    } as never);

    await application.publications.prepare({
      accountId: "account-1",
      requestId: "request-trace",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic",
    });

    expect(start).toHaveBeenCalledWith({
      operation: "publication.prepare",
      requestId: "request-trace",
      accountId: "account-1",
      platformId: "douyin",
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "account.verify",
        accountId: "account-1",
        platformId: "douyin",
      }),
    );
    expect(bind).toHaveBeenCalledWith({ publicationId: "publication-1" });
    expect(bind).toHaveBeenCalledWith({ pageId: "session-1" });
    expect(execution.mock.calls.map(([phase]) => phase)).toEqual([
      "prepare",
      "submit",
    ]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "automation.control_completed" }),
    );
  });

  it("refreshes accounts through the API without a sync notice", async () => {
    const { dependencies } = createPublishFixture();
    const show = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      notices: { show },
    } as never);
    const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await new RuntimeAccountRoutes(application).refresh(
      response as never,
      "account-1",
    );
    expect(response.statusCode).toBe(200);
    expect(show).not.toHaveBeenCalled();
  });

  it("refreshes account state without sync notices", async () => {
    const { dependencies, accounts } = createPublishFixture();
    const show = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      notices: { show },
    } as never);
    await application.accounts.verify({ accountId: "account-1" });
    expect(show).not.toHaveBeenCalled();
    await application.accounts.refresh({ accountId: "account-1" });
    expect(accounts.get("account-1")?.status).toBe("authenticated");
    expect(show).not.toHaveBeenCalled();

    const failed = createPublishFixture({ loginRequired: true });
    const failedApplication = new NediaMatrixApplication({
      ...failed.dependencies,
      notices: { show },
    } as never);
    await failedApplication.accounts.refresh({ accountId: "account-1" });
    expect(show).not.toHaveBeenCalled();
  });

  it("notifies after manual preparation and isolates notification failures", async () => {
    const { dependencies, actions } = createPublishFixture();
    const show = vi.fn(() => {
      expect(actions).toContain("mark:awaiting_confirmation");
      throw new Error("notifications unavailable");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const application = new NediaMatrixApplication({
        ...dependencies,
        notices: { show },
      } as never);
      const request = {
        accountId: "account-1",
        contentForm: "imageText" as const,
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        submissionMode: "manual_confirmation" as const,
      };
      await expect(
        application.publications.prepare(request),
      ).resolves.toMatchObject({
        status: "ready_for_review",
      });
      expect(show).toHaveBeenCalledTimes(1);
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "publish.awaiting_confirmation",
          accountId: "account-1",
        }),
      );
      expect(actions).not.toContain("workflow:publish.submit");
    } finally {
      log.mockRestore();
    }
  });

  it("does not prompt for manual publishing in automatic mode", async () => {
    const { dependencies } = createPublishFixture();
    const show = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      notices: { show },
    } as never);
    await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic",
    });
    expect(show).not.toHaveBeenCalled();
  });

  it.each(["manual_confirmation", "automatic"] as const)(
    "does not observe upload requests during preparation in %s mode",
    async (submissionMode) => {
      const { actions, dependencies } = createPublishFixture({
        publishDuringPreparation: true,
      });
      const application = new NediaMatrixApplication(dependencies as never);

      const result = await application.publications.prepare({
        accountId: "account-1",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        submissionMode,
      });

      expect(result.status).toBe(
        submissionMode === "manual_confirmation"
          ? "ready_for_review"
          : "submission_started",
      );
      expect(actions).not.toContain("observed:published");
      expect(actions.indexOf("arm")).toBeGreaterThan(
        actions.indexOf("workflow:publish.prepare.imageText"),
      );
    },
  );

  it("hands off a manual page when observation reaches verifying during preparation", async () => {
    const { actions, dependencies } = createPublishFixture({
      verifyDuringPreparation: true,
    });
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "manual_confirmation",
    });

    expect(result).toMatchObject({
      status: "already_started",
      state: "verifying",
    });
    expect(actions.indexOf("handoff")).toBeGreaterThan(
      actions.indexOf("workflow:publish.prepare.imageText"),
    );
    expect(actions).not.toContain("mark:awaiting_confirmation");
  });

  it("keeps manual confirmation before the submit workflow", async () => {
    const { actions, dependencies } = createPublishFixture();
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "manual_confirmation",
    });

    expect(result.status).toBe("ready_for_review");
    expect(actions).toEqual([
      "start",
      "ready",
      "workflow:publish.prepare.imageText",
      "consume",
      "handoff",
      "mark:awaiting_confirmation",
      "arm",
      "focus",
    ]);
  });

  it("hands a partially filled page to the user and explains that tracking stopped", async () => {
    const { actions, dependencies } = createPublishFixture({
      failPreparation: true,
    });
    const show = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      notices: { show },
    } as never);

    const result = await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "manual_confirmation",
    });

    expect(result.status).toBe("failed");
    expect(actions).toContain("handoff");
    expect(actions).not.toContain("arm");
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "publish.preparation_failed",
        pageAvailable: true,
        message: "editor fill failed",
      }),
    );
  });

  it("shows a failure notice after a human submission result", async () => {
    const { dependencies, finishObservation } = createPublishFixture();
    const show = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      notices: { show },
    } as never);

    await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "manual_confirmation",
    });
    await finishObservation({ kind: "failed", message: "平台返回 461" });

    expect(show).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "publish.failed",
        pageAvailable: true,
        message: "平台返回 461",
      }),
    );
  });

  it("composes Kuaishou title, body, and tags into a manual-review description", async () => {
    const { actions, dependencies, prepareWorkflowInputs } =
      createPublishFixture({ platformId: "kuaishou", contentForm: "video" });
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepare({
      accountId: "account-1",
      contentForm: "video",
      mediaSelectionId: "selection-1",
      title: "快手标题",
      body: "快手正文",
      tags: ["旅行", "周末"],
      submissionMode: "manual_confirmation",
    });

    expect(result.status).toBe("ready_for_review");
    expect(prepareWorkflowInputs()?.description).toBe(
      "快手标题 快手正文 #旅行 #周末",
    );
    expect(actions).not.toContain("workflow:publish.submit");
  });

  it("arms Kuaishou result observation before automatic submission", async () => {
    const { actions, dependencies } = createPublishFixture({
      platformId: "kuaishou",
      contentForm: "video",
    });
    const application = new NediaMatrixApplication(dependencies as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        contentForm: "video",
        mediaSelectionId: "selection-1",
        title: "快手标题",
        body: "快手正文",
        submissionMode: "automatic",
      }),
    ).resolves.toMatchObject({ status: "submission_started" });
    expect(actions).toEqual([
      "start",
      "ready",
      "workflow:publish.prepare.video",
      "consume",
      "arm",
      "mark:submitting",
      "attempt",
      "workflow:publish.submit",
    ]);
  });

  it("maps an unavailable media token to a recoverable selection error", async () => {
    const { actions, dependencies } = createPublishFixture({
      platformId: "kuaishou",
      contentForm: "video",
      mediaSelectionUnavailable: true,
    });
    const application = new NediaMatrixApplication(dependencies as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        contentForm: "video",
        mediaSelectionId: "expired-selection",
        title: "快手标题",
        body: "快手正文",
        submissionMode: "automatic",
      }),
    ).resolves.toEqual({
      status: "failed",
      code: "MEDIA_SELECTION_UNAVAILABLE",
      message: "媒体选择已失效，请重新选择文件",
      evidenceId: null,
    });
    expect(actions).not.toContain("workflow:publish.submit");
  });

  it("prepares Kuaishou image-text for manual review without submitting", async () => {
    const { actions, dependencies, prepareWorkflowInputs } =
      createPublishFixture({
        platformId: "kuaishou",
        contentForm: "imageText",
      });
    const application = new NediaMatrixApplication(dependencies as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "快手图文标题",
        body: "快手图文正文",
        tags: ["旅行"],
        submissionMode: "manual_confirmation",
      }),
    ).resolves.toMatchObject({ status: "ready_for_review" });
    expect(prepareWorkflowInputs()?.description).toBe(
      "快手图文标题 快手图文正文 #旅行",
    );
    expect(actions).not.toContain("workflow:publish.submit");
  });

  it("arms Kuaishou image-text observation before automatic submission", async () => {
    const { actions, dependencies } = createPublishFixture({
      platformId: "kuaishou",
      contentForm: "imageText",
    });
    const application = new NediaMatrixApplication(dependencies as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "快手图文标题",
        body: "快手图文正文",
        submissionMode: "automatic",
      }),
    ).resolves.toMatchObject({ status: "submission_started" });
    expect(actions).toEqual([
      "start",
      "ready",
      "workflow:publish.prepare.imageText",
      "consume",
      "arm",
      "mark:submitting",
      "attempt",
      "workflow:publish.submit",
    ]);
  });

  it("persists normalized tags and sends native topic inputs to the workflow", async () => {
    const { dependencies, preparationInput, prepareWorkflowInputs } =
      createPublishFixture();
    const application = new NediaMatrixApplication(dependencies as never);

    await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic" as const,
      tags: [" #旅行 ", "旅行", "周末去哪儿"],
    });

    expect(preparationInput()?.tags).toEqual(["旅行", "周末去哪儿"]);
    expect(preparationInput()?.body).toBe("正文");
    expect(prepareWorkflowInputs()?.body).toBe("正文");
    expect(prepareWorkflowInputs()?.tags).toEqual(["旅行", "周末去哪儿"]);
    expect(prepareWorkflowInputs()?.mediaPaths).toEqual(["/tmp/image.jpg"]);
    expect(prepareWorkflowInputs()).not.toHaveProperty("mediaReferences");
  });

  it("formats inline topics before persisting and filling the body", async () => {
    const { dependencies, preparationInput, prepareWorkflowInputs } =
      createPublishFixture();
    const application = new NediaMatrixApplication(dependencies as never);

    await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "这样吗#与异性的分寸感 #朋友的重要性",
      submissionMode: "automatic",
    });

    const formatted = "这样吗 #与异性的分寸感 #朋友的重要性";
    expect(preparationInput()?.body).toBe(formatted);
    expect(prepareWorkflowInputs()?.body).toBe(formatted);
  });

  it("rejects a second publication while the same account is active", async () => {
    const { dependencies, finishObservation } = createPublishFixture();
    const application = new NediaMatrixApplication(dependencies as never);
    const request = {
      accountId: "account-1",
      contentForm: "imageText" as const,
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic" as const,
    };

    await expect(
      application.publications.prepare(request),
    ).resolves.toMatchObject({
      status: "submission_started",
    });
    await expect(
      application.publications.prepare({ ...request, requestId: "request-2" }),
    ).resolves.toEqual({ status: "account_busy" });

    await finishObservation();
    await expect(
      application.publications.prepare({ ...request, requestId: "request-3" }),
    ).resolves.toMatchObject({ status: "submission_started" });
  });

  it("rejects publication when the persistent profile switched accounts", async () => {
    const { accounts, accountUpdates, actions, dependencies } =
      createPublishFixture({
        detectedExternalAccountId: "external-2",
      });
    const application = new NediaMatrixApplication(dependencies as never);

    await expect(
      application.publications.prepare({
        accountId: "account-1",
        requestId: "request-1",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        submissionMode: "automatic",
      }),
    ).resolves.toEqual({
      status: "account_unknown",
      reason:
        "当前登录的抖音账号与本地记录不一致，请切回原账号或刷新账号信息后重试",
    });
    expect(actions).toEqual([]);
    expect(accounts.get("account-1")).toMatchObject({
      externalAccountId: "external-1",
      nickname: "测试账号",
      status: "unknown",
    });
    expect(accountUpdates).toHaveLength(1);

    dependencies.sessionDetector = async () => ({
      status: "authenticated" as const,
      identityScheme: "douyin.short_id",
      externalAccountId: "external-1",
      nickname: "测试账号",
      avatarUrl: null,
      accountInfo: [],
      source: "api" as const,
    });
    const retriedApplication = new NediaMatrixApplication(
      dependencies as never,
    );
    await expect(
      retriedApplication.publications.prepare({
        accountId: "account-1",
        requestId: "request-2",
        contentForm: "imageText",
        mediaSelectionId: "selection-1",
        title: "标题",
        body: "正文",
        submissionMode: "automatic",
      }),
    ).resolves.toMatchObject({ status: "submission_started" });
  });

  it("refreshes stored account identity during publish verification", async () => {
    const { accounts, accountUpdates, dependencies } = createPublishFixture();
    dependencies.sessionDetector = async () => ({
      status: "authenticated" as const,
      identityScheme: "douyin.short_id",
      externalAccountId: "external-1",
      nickname: "更新后的账号",
      avatarUrl: "https://example.test/avatar.png",
      source: "api" as const,
    });
    const application = new NediaMatrixApplication(dependencies as never);

    await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic",
    });

    expect(accounts.get("account-1")).toMatchObject({
      displayName: "更新后的账号",
      nickname: "更新后的账号",
      avatarUrl: "https://example.test/avatar.png",
      accountInfo: [],
      status: "authenticated",
      lastVerifiedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(accountUpdates).toHaveLength(1);
  });

  it("discards downloaded assets when the account is already publishing", async () => {
    const { actions, dependencies } = createPublishFixture();
    const application = new NediaMatrixApplication(dependencies as never);
    await application.publications.prepare({
      accountId: "account-1",
      requestId: "request-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
    });
    actions.splice(0);

    const result = await application.publications.prepareRemote({
      accountId: "account-1",
      requestId: "request-2",
      contentForm: "imageText",
      title: "标题 2",
      body: "正文 2",
      assets: [
        {
          url: "https://assets.example.test/image.png",
          name: "image.png",
          mediaType: "image/png",
          role: "image",
          order: 0,
        },
      ],
    });

    expect(result).toEqual({ status: "account_busy" });
    expect(actions).toEqual([
      "download",
      "create-selection",
      "consume",
      "discard",
    ]);
  });

  it("marks an automatic submit error uncertain instead of retryable failed", async () => {
    const { actions, dependencies } = createPublishFixture({
      failSubmit: true,
    });
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepare({
      accountId: "account-1",
      contentForm: "imageText",
      mediaSelectionId: "selection-1",
      title: "标题",
      body: "正文",
      submissionMode: "automatic",
    });

    expect(result).toMatchObject({
      status: "uncertain",
      code: "SUBMISSION_RESULT_UNCERTAIN",
    });
    expect(actions).toContain("mark:uncertain");
    expect(actions).not.toContain("mark:failed");
  });

  it("downloads remote assets into the human-confirmed publish workflow", async () => {
    const { actions, dependencies, preparationInput } = createPublishFixture();
    const show = vi.fn();
    const application = new NediaMatrixApplication({
      ...dependencies,
      notices: { show },
    } as never);

    const result = await application.publications.prepareRemote({
      accountId: "account-1",
      requestId: "request-1",
      contentForm: "imageText",
      title: "标题",
      body: "正文",
      assets: [
        {
          url: "https://assets.example.test/image.png",
          name: "image.png",
          mediaType: "image/png",
          role: "image",
          order: 0,
        },
      ],
    });

    expect(result.status).toBe("ready_for_review");
    expect(show).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "publish.awaiting_confirmation",
        accountId: "account-1",
      }),
    );
    expect(actions.slice(0, 7)).toEqual([
      "download",
      "create-selection",
      "start",
      "ready",
      "workflow:publish.prepare.imageText",
      "consume",
      "handoff",
    ]);
    expect(actions).not.toContain("discard");
    expect(preparationInput()?.assets).toEqual([
      expect.objectContaining({
        hash: "a".repeat(64),
        localRelativePath: `sha256/aa/${"a".repeat(64)}.png`,
        sourceOrigin: "https://assets.example.test",
      }),
    ]);
  });

  it("discards remote assets when login prevents creating a publication", async () => {
    const { accounts, accountUpdates, actions, dependencies } =
      createPublishFixture({
        loginRequired: true,
      });
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepareRemote({
      accountId: "account-1",
      requestId: "request-1",
      contentForm: "imageText",
      title: "标题",
      body: "正文",
      assets: [
        {
          url: "https://assets.example.test/image.png",
          name: "image.png",
          mediaType: "image/png",
          role: "image",
          order: 0,
        },
      ],
    });

    expect(result.status).toBe("login_required");
    expect(actions).toEqual([
      "download",
      "create-selection",
      "consume",
      "discard",
    ]);
    expect(accounts.get("account-1")?.status).toBe("login_required");
    expect(accountUpdates).toHaveLength(1);
  });

  it("returns an existing publication before downloading remote assets", async () => {
    const { actions, dependencies } = createPublishFixture({
      existingPublication: true,
    });
    const application = new NediaMatrixApplication(dependencies as never);

    const result = await application.publications.prepareRemote({
      accountId: "account-1",
      requestId: "request-1",
      contentForm: "imageText",
      title: "标题",
      body: "正文",
      assets: [
        {
          url: "https://assets.example.test/image.png",
          name: "image.png",
          mediaType: "image/png",
          role: "image",
          order: 0,
        },
      ],
    });

    expect(result).toMatchObject({
      status: "already_started",
      publicationId: "publication-1",
    });
    expect(actions).toEqual([]);
  });
});
