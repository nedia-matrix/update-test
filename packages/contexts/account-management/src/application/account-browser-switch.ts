import type { SessionDetectionPlan } from "@nedia-matrix/automation-engine";
import type { PlatformModule } from "@nedia-matrix/platform-sdk";
import type {
  CanonicalAccountIdentity,
  PlatformAccountSnapshot,
} from "../domain/index.js";

export type AccountBrowserProvider = "system" | "fingerprint";

/** Internal durable record. Profiles are opaque IDs; never kernel paths or seeds. */
export interface AccountBrowserSwitchOperation {
  operationId: string;
  accountId: string;
  originalProfileId: string;
  candidateProfileId: string;
  targetProvider: AccountBrowserProvider;
  identity: CanonicalAccountIdentity;
  phase: "preparing" | "awaiting_login" | "committed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface AccountBrowserSwitchRepository {
  create(operation: AccountBrowserSwitchOperation): void;
  get(operationId: string): AccountBrowserSwitchOperation | undefined;
  list(): AccountBrowserSwitchOperation[];
  pruneTerminal(olderThan: string): void;
  markAwaitingLogin(
    operationId: string,
    occurredAt: string,
  ): AccountBrowserSwitchOperation;
  commit(input: {
    operationId: string;
    identity: CanonicalAccountIdentity;
    nickname: string;
    avatarUrl: string | null;
    occurredAt: string;
    removeRetiredProfileAfter: string;
  }): PlatformAccountSnapshot;
  cancel(
    operationId: string,
    occurredAt: string,
  ): AccountBrowserSwitchOperation;
}

/** Pin detection to the established scheme rather than accepting a different fallback. */
export function accountBrowserSwitchDetection(
  platform: PlatformModule,
  account: PlatformAccountSnapshot,
):
  | { supported: true; plan: SessionDetectionPlan }
  | { supported: false; reason: string } {
  if (
    account.lifecycle !== "active" ||
    !account.identityScheme ||
    !account.externalAccountId
  )
    return { supported: false, reason: "请先完成账号登录并确认稳定身份" };
  if (platform.id !== account.platformId)
    return { supported: false, reason: "账号与平台不一致" };
  if (platform.accounts.duplicateProfileReplacement !== "enabled")
    return {
      supported: false,
      reason: `${platform.displayName}暂未开放稳定身份环境替换`,
    };
  const detection = platform.accounts.detection;
  const probes = detection.probes.filter(
    (probe) => probe.identityScheme === account.identityScheme,
  );
  if (!probes.length)
    return {
      supported: false,
      reason: "当前账号的身份来源无法通过平台接口确认，请先刷新账号身份",
    };
  const { domFallback, ...base } = detection;
  return {
    supported: true,
    plan: {
      ...base,
      probes,
      ...(domFallback?.identityScheme === account.identityScheme
        ? { domFallback }
        : {}),
    },
  };
}
