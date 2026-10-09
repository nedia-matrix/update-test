interface RuntimeShutdownDependencies {
  publishObservations: {
    stopAll(): Promise<void>;
  };
  mediaSelections: {
    clear(): void;
  };
  browserSessions: {
    closeAll(): Promise<void>;
  };
  diagnostics?: {
    flush(): Promise<void>;
    close(): Promise<void>;
  };
  report?(event: string, details?: Readonly<Record<string, unknown>>): void;
  finishDiagnostics?(result: { outcome: string; message?: string }): void;
}

export type ShutdownWaitResult = "completed" | "timed-out";

export async function shutdownDesktopRuntime(
  dependencies: RuntimeShutdownDependencies,
): Promise<void> {
  try {
    await dependencies.publishObservations.stopAll();
    dependencies.report?.("application.shutdown.observations_stopped");
    dependencies.mediaSelections.clear();
    dependencies.report?.("application.shutdown.media_selections_cleared");
    await dependencies.browserSessions.closeAll();
    dependencies.report?.("application.shutdown.browsers_closed");
    dependencies.report?.("application.shutdown.logs_flush_started");
    await dependencies.diagnostics?.flush();
    dependencies.report?.("application.shutdown.logs_flush_completed");
    dependencies.finishDiagnostics?.({ outcome: "completed" });
  } catch (error) {
    dependencies.report?.("application.shutdown.failed", {
      code: "SHUTDOWN_CLEANUP_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error ? error.message : "Desktop shutdown failed",
    });
    dependencies.finishDiagnostics?.({
      outcome: "failed",
      message:
        error instanceof Error ? error.message : "Desktop shutdown failed",
    });
    throw error;
  } finally {
    await dependencies.diagnostics?.close();
  }
}

export async function waitForShutdown(
  shutdown: Promise<void>,
  timeoutMs: number,
): Promise<ShutdownWaitResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Shutdown timeout must be non-negative");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ShutdownWaitResult>((resolve) => {
    timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
  });

  try {
    return await Promise.race([
      shutdown.then((): ShutdownWaitResult => "completed"),
      timedOut,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
