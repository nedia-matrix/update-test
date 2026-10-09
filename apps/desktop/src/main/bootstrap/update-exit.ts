import type { PreparedInstallation } from "../updates/update-installation.js";
import { waitForShutdown } from "./runtime-cleanup.js";

/** An update permit is granted only after every cleanup step and database close succeeds. */
export async function completeUpdateExit(
  prepared: PreparedInstallation,
  dependencies: {
    cleanup(): Promise<void>;
    closeDatabase(): void;
    exit(): void;
  },
  timeoutMs = 15_000,
): Promise<void> {
  try {
    if (
      (await waitForShutdown(dependencies.cleanup(), timeoutMs)) !== "completed"
    )
      throw new Error("更新退出清理超时");
    dependencies.closeDatabase();
    await prepared.commit();
    dependencies.exit();
  } catch (error) {
    await prepared.cancel();
    throw error;
  }
}
