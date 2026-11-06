import { waitForShutdown } from "./runtime-cleanup.js";

/** A deadline is a progress notification, never permission to release ownership. */
export async function completeRuntimeExit(
  dependencies: {
    cleanup(): Promise<void>;
    delayed(): void;
    closeDatabase(): void;
    exit(): void;
  },
  noticeAfterMs: number,
): Promise<void> {
  const cleanup = dependencies.cleanup();
  if ((await waitForShutdown(cleanup, noticeAfterMs)) === "timed-out") {
    try {
      dependencies.delayed();
    } catch {
      /* Notification failure never releases a live runtime. */
    }
    await cleanup;
  }
  dependencies.closeDatabase();
  dependencies.exit();
}

/** Drain every started cleanup before allowing a failed attempt to be retried. */
export async function drainCleanup(
  operations: Promise<unknown>[],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "退出清理尚未完成");
}
