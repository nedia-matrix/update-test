import { randomUUID } from "node:crypto";

import type {
  ManagedPublishObservation,
  PublishAutomationDiagnosticTrace,
  PublishObservationEvent,
} from "@nedia-matrix/publishing";
import type {
  PublishResultEvent,
  PublishResultMonitor,
} from "@nedia-matrix/platform-sdk";

export class PublishObservationManager {
  private readonly observations = new Map<string, ManagedPublishObservation>();

  constructor(
    private readonly onEvent: (event: PublishObservationEvent) => Promise<void>,
  ) {}

  attach(input: {
    publicationId: string;
    accountId: string;
    platformId: string;
    monitor: PublishResultMonitor;
    diagnostics?: PublishAutomationDiagnosticTrace;
    onFinished?: (result?: PublishResultEvent) => void | Promise<void>;
  }): ManagedPublishObservation {
    void this.stop(input.accountId);
    const id = randomUUID();
    let stopped = false;
    let armed = false;
    let completed = false;
    let finishing: Promise<void> | undefined;
    let sequence = 0;
    let persistenceTail = Promise.resolve();
    let submissionAttempt: Promise<void> | undefined;
    let hasSubmissionEvidence = false;
    let hosted: ManagedPublishObservation;
    const report = (
      event: string,
      details?: Readonly<Record<string, unknown>>,
      level?: "debug" | "info" | "warn" | "error",
    ) => {
      try {
        input.diagnostics?.report({
          component: "monitor",
          event,
          ...(level ? { level } : {}),
          ...(details ? { details } : {}),
        });
      } catch {
        // Diagnostics must not affect publication observation.
      }
    };
    const finishDiagnostics = (outcome: string) => {
      try {
        input.diagnostics?.finish({ outcome });
      } catch {
        // Diagnostics must not affect publication observation.
      }
    };
    report("monitor.attached");
    const finish = (result?: PublishResultEvent): Promise<void> =>
      (finishing ??= Promise.resolve().then(() => input.onFinished?.(result)));
    const persist = (result: PublishResultEvent): Promise<void> => {
      const event: PublishObservationEvent = {
        eventId: randomUUID(),
        observationId: id,
        publicationId: input.publicationId,
        accountId: input.accountId,
        platformId: input.platformId,
        sequence: ++sequence,
        result,
      };
      report("monitor.result_received", {
        kind: result.kind,
        source: "source" in result ? result.source : undefined,
      });
      persistenceTail = persistenceTail.then(async () => {
        await this.onEvent(event);
        report("monitor.result_persisted", { kind: result.kind });
      });
      return persistenceTail;
    };
    let unsubscribe = (): void => undefined;
    const finalize = async (result?: PublishResultEvent): Promise<void> => {
      unsubscribe();
      input.monitor.stop();
      if (this.observations.get(input.accountId) === hosted) {
        this.observations.delete(input.accountId);
      }
      await finish(result);
    };
    unsubscribe = input.monitor.subscribe((result) => {
      if (
        result.kind === "submission_attempted" ||
        result.kind === "verification_required" ||
        result.kind === "verifying" ||
        result.kind === "published"
      ) {
        hasSubmissionEvidence = true;
      }
      const persisted = persist(result);
      if (
        result.kind === "published" ||
        result.kind === "failed" ||
        result.kind === "uncertain" ||
        result.kind === "cancelled"
      ) {
        completed = true;
        void persisted
          .then(async () => {
            await finalize(result);
            finishDiagnostics(result.kind);
          })
          .catch((error: unknown) => {
            report(
              "monitor.result_persist_failed",
              {
                kind: result.kind,
                errorName: error instanceof Error ? error.name : "UnknownError",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to finalize publish observation",
              },
              "error",
            );
            console.error("Failed to finalize publish observation", error);
          });
      }
    });
    hosted = {
      id,
      ready: () => input.monitor.ready(),
      arm: () => {
        input.monitor.arm();
        armed = true;
      },
      beginSubmissionAttempt: async () => {
        hasSubmissionEvidence = true;
        submissionAttempt ??= persist({
          kind: "submission_attempted",
          source: "application_commit",
          message: "应用即将执行平台提交操作",
        }).then(() => input.monitor.submissionAttempted());
        await submissionAttempt;
      },
      interrupt: async (reason = "observation_interrupted") => {
        if (stopped) return;
        stopped = true;
        if (!completed && armed) {
          await input.monitor.interrupt(reason);
        }
        await persistenceTail;
        await finalize();
        if (!completed) finishDiagnostics(reason);
      },
      stopSilently: async () => {
        if (hasSubmissionEvidence) {
          await hosted.interrupt();
          return;
        }
        if (stopped) return;
        stopped = true;
        unsubscribe();
        input.monitor.stop();
        if (this.observations.get(input.accountId) === hosted) {
          this.observations.delete(input.accountId);
        }
        await finish();
        report("monitor.stopped_silently");
      },
    };
    this.observations.set(input.accountId, hosted);
    return hosted;
  }

  hasActive(): boolean {
    return this.observations.size > 0;
  }

  async stop(accountId: string): Promise<void> {
    await this.observations.get(accountId)?.interrupt();
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.observations.values()].map((observation) =>
        observation.interrupt("desktop_shutdown"),
      ),
    );
  }
}
