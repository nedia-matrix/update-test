import { resolveAccountPlatform } from "@nedia-matrix/platform-sdk";
import type { PlatformSessionDetection } from "@nedia-matrix/automation-engine";
import {
  PlatformAccount,
  type CanonicalAccountIdentity,
  type PlatformAccountSnapshot,
} from "../domain/index.js";
import type {
  AccountRepository,
  BrowserSessionPort,
  PlatformCatalog,
} from "./account-ports.js";
import type { RetiredProfileCleaner } from "./retired-profile-cleaner.js";

const REPLACEMENT_ALIAS_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const RETIRED_PROFILE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export type SessionDetection = PlatformSessionDetection;
type AuthenticatedDetection = Extract<
  SessionDetection,
  { status: "authenticated" }
>;

export interface CandidateReconciliationResult {
  detection: SessionDetection;
  retry: boolean;
}

interface AccountIdentityServiceDependencies {
  platforms: PlatformCatalog;
  accountStore: Pick<
    AccountRepository,
    | "findActiveByIdentity"
    | "get"
    | "put"
    | "replaceCandidateProfile"
    | "require"
  >;
  browserSessions: Pick<BrowserSessionPort, "closeAutomation">;
  retiredProfiles: Pick<RetiredProfileCleaner, "schedule">;
  now(): Date;
  isAccountBusy?(accountId: string): boolean;
  onAccountsChanged?(): void;
  cancelRecognition?(accountId: string): void;
}

export class AccountIdentityService {
  private readonly transitions = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: AccountIdentityServiceDependencies,
  ) {}

  recordEstablished(
    account: PlatformAccountSnapshot,
    detected: SessionDetection,
  ): SessionDetection {
    if (detected.status === "unknown" && account.status === "authenticated") {
      return detected;
    }
    if (
      detected.status === "authenticated" &&
      account.externalAccountId !== null &&
      (detected.externalAccountId !== account.externalAccountId ||
        (account.identityScheme !== null &&
          detected.identityScheme !== account.identityScheme))
    ) {
      const platform = resolveAccountPlatform(
        this.dependencies.platforms,
        account,
      );
      const mismatch: SessionDetection = {
        status: "unknown",
        reason: `当前登录的${platform.displayName}账号与本地记录不一致，请切回原账号或刷新账号信息后重试`,
      };
      this.persist(account, mismatch);
      return mismatch;
    }
    this.persist(account, detected);
    return detected;
  }

  recordRefresh(
    account: PlatformAccountSnapshot,
    detected: SessionDetection,
  ): SessionDetection {
    if (detected.status !== "authenticated") {
      if (detected.status === "unknown" && account.status === "authenticated") {
        return detected;
      }
      this.persist(account, detected);
      return detected;
    }
    const identity = identityOf(account.platformId, detected);
    const conflict = this.dependencies.accountStore
      .findActiveByIdentity(identity)
      .find((candidate) => candidate.id !== account.id);
    if (conflict) {
      const mismatch: SessionDetection = {
        status: "unknown",
        reason: "当前登录的平台账号已由另一个本地账号管理",
      };
      this.persist(account, mismatch);
      return mismatch;
    }
    const aggregate = PlatformAccount.rehydrate(account);
    aggregate.refreshIdentity(detected, this.dependencies.now().toISOString());
    this.dependencies.accountStore.put(aggregate.toSnapshot());
    this.dependencies.onAccountsChanged?.();
    return detected;
  }

  persistAutomatic(accountId: string, detected: SessionDetection): void {
    const account = this.dependencies.accountStore.get(accountId);
    if (!account) return;
    if (
      account.lifecycle === "pending_identity" &&
      detected.status === "authenticated"
    ) {
      this.persistCandidateConflict(
        account,
        "账号登录环境暂时无法完成替换，请稍后刷新重试",
      );
      return;
    }
    this.recordEstablished(account, detected);
  }

  async reconcileCandidate(
    candidateAccountId: string,
    detected: AuthenticatedDetection,
  ): Promise<CandidateReconciliationResult> {
    const initialCandidate =
      this.dependencies.accountStore.require(candidateAccountId);
    const identity = identityOf(initialCandidate.platformId, detected);
    return this.withIdentityTransition(identity, async () => {
      const candidate = this.dependencies.accountStore.get(candidateAccountId);
      if (!candidate) return { detection: detected, retry: false };
      if (candidate.lifecycle !== "pending_identity") {
        return {
          detection: this.recordEstablished(candidate, detected),
          retry: false,
        };
      }

      const matches = this.dependencies.accountStore
        .findActiveByIdentity(identity)
        .filter((account) => account.id !== candidate.id);
      if (matches.length === 0) {
        this.persist(candidate, detected);
        return { detection: detected, retry: false };
      }
      if (matches.length > 1) {
        return {
          detection: this.persistCandidateConflict(
            candidate,
            "检测到多条历史重复账号，无法自动选择保留记录",
          ),
          retry: false,
        };
      }

      const platform = resolveAccountPlatform(
        this.dependencies.platforms,
        candidate,
      );
      if (platform.accounts.duplicateProfileReplacement !== "enabled") {
        return {
          detection: this.persistCandidateConflict(
            candidate,
            `${platform.displayName}账号身份来源尚未统一，暂不能自动替换已有环境`,
          ),
          retry: false,
        };
      }

      const survivingAccount = matches[0]!;
      if (this.dependencies.isAccountBusy?.(survivingAccount.id)) {
        const deferred: SessionDetection = {
          status: "unknown",
          reason: "已有账号正在执行发布，将在任务结束后继续更新登录环境",
        };
        if (candidate.status !== "unknown") this.persist(candidate, deferred);
        return { detection: deferred, retry: true };
      }

      await this.dependencies.browserSessions.closeAutomation(survivingAccount);
      await this.dependencies.browserSessions.closeAutomation(candidate);

      if (
        this.dependencies.isAccountBusy?.(survivingAccount.id) ||
        this.dependencies.isAccountBusy?.(candidate.id) ||
        !this.dependencies.accountStore.get(candidate.id) ||
        !this.dependencies.accountStore.get(survivingAccount.id)
      ) {
        return { detection: detected, retry: false };
      }

      const replacedAt = this.dependencies.now();
      const replacement =
        this.dependencies.accountStore.replaceCandidateProfile({
          candidateAccountId: candidate.id,
          survivingAccountId: survivingAccount.id,
          identity,
          nickname: detected.nickname,
          avatarUrl: detected.avatarUrl,
          replacedAt: replacedAt.toISOString(),
          aliasExpiresAt: addMilliseconds(
            replacedAt,
            REPLACEMENT_ALIAS_LIFETIME_MS,
          ),
          removeRetiredProfileAfter: addMilliseconds(
            replacedAt,
            RETIRED_PROFILE_LIFETIME_MS,
          ),
        });
      this.dependencies.cancelRecognition?.(candidate.id);
      this.dependencies.retiredProfiles.schedule(replacement.retiredProfile);
      this.dependencies.onAccountsChanged?.();
      return { detection: detected, retry: false };
    });
  }

  private persistCandidateConflict(
    account: PlatformAccountSnapshot,
    reason: string,
  ): SessionDetection {
    const conflict: SessionDetection = { status: "unknown", reason };
    this.persist(account, conflict);
    return conflict;
  }

  private persist(
    account: PlatformAccountSnapshot,
    detected: SessionDetection,
  ): PlatformAccountSnapshot {
    const now = this.dependencies.now().toISOString();
    const aggregate = PlatformAccount.rehydrate(account);
    aggregate.recordDetection(detected, now);
    this.dependencies.accountStore.put(aggregate.toSnapshot());
    this.dependencies.onAccountsChanged?.();
    return aggregate.toSnapshot();
  }

  private async withIdentityTransition<T>(
    identity: CanonicalAccountIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${identity.platformId}\u0000${identity.identityScheme}\u0000${identity.externalAccountId}`;
    const previous = this.transitions.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.transitions.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.transitions.get(key) === queued) this.transitions.delete(key);
    }
  }
}

function identityOf(
  platformId: string,
  detected: AuthenticatedDetection,
): CanonicalAccountIdentity {
  return {
    platformId,
    identityScheme: detected.identityScheme,
    externalAccountId: detected.externalAccountId,
  };
}

function addMilliseconds(value: Date, milliseconds: number): string {
  return new Date(value.getTime() + milliseconds).toISOString();
}
