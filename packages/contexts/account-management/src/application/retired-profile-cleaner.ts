/// <reference lib="dom" />

import type {
  AccountDiagnosticPort,
  AccountDiagnosticTrace,
  AccountRepository,
  BrowserSessionPort,
} from "./account-ports.js";
import type { RetiredBrowserProfile } from "../domain/index.js";

interface RetiredProfileCleanerDependencies {
  accountStore: Pick<
    AccountRepository,
    | "discardRetiredProfile"
    | "hasProfileReference"
    | "listRetiredProfiles"
    | "pruneExpiredAliases"
  >;
  browserSessions: Pick<BrowserSessionPort, "removeProfile">;
  now(): Date;
  createId(): string;
  diagnostics?: AccountDiagnosticPort;
}

function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}

export class RetiredProfileCleaner {
  constructor(
    private readonly dependencies: RetiredProfileCleanerDependencies,
  ) {}

  async cleanupDue(): Promise<void> {
    const now = this.dependencies.now();
    this.dependencies.accountStore.pruneExpiredAliases(now);
    const dueProfiles = this.dependencies.accountStore
      .listRetiredProfiles()
      .filter((profile) => profile.removeAfter <= now.toISOString());
    const trace = this.dependencies.diagnostics?.start({
      operation: "profile.cleanup",
      requestId: this.dependencies.createId(),
    });
    trace?.report({
      component: "resource",
      event: "profile.cleanup.started",
      details: { count: dueProfiles.length },
    });
    try {
      for (const profile of dueProfiles) {
        await this.remove(profile, trace);
      }
      trace?.finish({ outcome: "completed" });
    } catch (error) {
      trace?.report({
        component: "resource",
        event: "profile.cleanup.failed",
        level: "error",
        details: {
          code: "PROFILE_CLEANUP_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error ? error.message : "Profile cleanup failed",
          retryable: true,
        },
      });
      trace?.finish({
        outcome: "failed",
        message:
          error instanceof Error ? error.message : "Profile cleanup failed",
      });
      throw error;
    }
  }

  schedule(profile: RetiredBrowserProfile): void {
    const delay = Math.max(
      0,
      new Date(profile.removeAfter).getTime() -
        this.dependencies.now().getTime(),
    );
    const timer = setTimeout(() => {
      const trace = this.dependencies.diagnostics?.start({
        operation: "profile.cleanup",
        accountId: profile.survivingAccountId,
        requestId: this.dependencies.createId(),
      });
      trace?.report({
        component: "resource",
        event: "profile.cleanup.started",
        details: { count: 1 },
      });
      void this.remove(profile, trace)
        .then(() => trace?.finish({ outcome: "completed" }))
        .catch((error: unknown) => {
          trace?.report({
            component: "resource",
            event: "profile.cleanup.failed",
            level: "error",
            details: {
              code: "PROFILE_CLEANUP_FAILED",
              errorName: error instanceof Error ? error.name : "UnknownError",
              message:
                error instanceof Error
                  ? error.message
                  : "Profile cleanup failed",
              retryable: true,
            },
          });
          trace?.finish({ outcome: "failed" });
          console.error("Failed to remove retired browser profile", error);
        });
    }, delay);
    unrefTimer(timer);
  }

  private async remove(
    profile: RetiredBrowserProfile,
    trace?: AccountDiagnosticTrace,
  ): Promise<void> {
    if (this.dependencies.accountStore.hasProfileReference(profile.profileId)) {
      trace?.report({
        component: "resource",
        event: "profile.cleanup.deferred",
        level: "warn",
        details: { reasonCode: "PROFILE_STILL_REFERENCED", retryable: true },
      });
      console.error(
        "Retired browser profile is still referenced by an account",
      );
      return;
    }
    await this.dependencies.browserSessions.removeProfile(profile.profileId);
    this.dependencies.accountStore.discardRetiredProfile(profile.profileId);
    trace?.report({
      component: "resource",
      event: "profile.cleanup.item_completed",
      details: { count: 1 },
    });
  }
}
