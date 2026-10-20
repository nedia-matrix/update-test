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
  private readonly directExecutions = new Map<
    string,
    { interrupt(): Promise<void> }
  >();
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
    if (this.directExecutions.has(input.accountId))
      throw new Error("Account already has an active API execution");
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
    return this.observations.size > 0 || this.directExecutions.size > 0;
  }

  attachDirect(input: {
    publicationId: string;
    accountId: string;
    platformId: string;
    onInterrupt(): void;
  }) {
    if (
      this.directExecutions.has(input.accountId) ||
      this.observations.has(input.accountId)
    )
      throw new Error("Account already has an active publication execution");
    const id = randomUUID();
    let sequence = 0;
    let closed = false;
    let tail = Promise.resolve();
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let interrupted = false;
    const hosted = {
      interrupt: async () => {
        if (!interrupted) {
          interrupted = true;
          input.onInterrupt();
        }
        await completed;
      },
    };
    this.directExecutions.set(input.accountId, hosted);
    return {
      id,
      persist: (result: PublishResultEvent) => {
        if (closed) return Promise.reject(new Error("API execution closed"));
        const event = {
          eventId: randomUUID(),
          observationId: id,
          publicationId: input.publicationId,
          accountId: input.accountId,
          platformId: input.platformId,
          sequence: ++sequence,
          result,
        };
        tail = tail.then(() => this.onEvent(event));
        return tail;
      },
      close: async () => {
        closed = true;
        try {
          await tail;
        } finally {
          if (this.directExecutions.get(input.accountId) === hosted)
            this.directExecutions.delete(input.accountId);
          finish();
        }
      },
    };
  }

  async stop(accountId: string): Promise<void> {
    const direct = this.directExecutions.get(accountId);
    const observation = this.observations.get(accountId);
    if (direct) await direct.interrupt();
    await observation?.interrupt();
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.observations.values(), ...this.directExecutions.values()].map(
        (observation) => observation.interrupt("desktop_shutdown"),
      ),
    );
  }
}
