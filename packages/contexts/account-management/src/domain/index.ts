import type { PlatformAccountInfoItem } from "./account-info.js";

export const platformAccountStatuses = [
  "authenticated",
  "login_required",
  "unknown",
] as const;
export type PlatformAccountStatus = (typeof platformAccountStatuses)[number];

export const platformAccountLifecycles = [
  "pending_identity",
  "active",
] as const;
export type PlatformAccountLifecycle =
  (typeof platformAccountLifecycles)[number];

export {
  platformAccountInfoKeys,
  type PlatformAccountInfoItem,
  type PlatformAccountInfoKey,
} from "./account-info.js";

export interface PlatformAccountSnapshot {
  id: string;
  platformId: string;
  readonly settings?: import("@nedia-matrix/platform-sdk").PlatformSettings;
  profileId: string;
  lifecycle: PlatformAccountLifecycle;
  displayName: string;
  identityScheme: string | null;
  externalAccountId: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  accountInfo?: readonly PlatformAccountInfoItem[];
  profileSyncedAt: string | null;
  status: PlatformAccountStatus;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalAccountIdentity {
  platformId: string;
  identityScheme: string;
  externalAccountId: string;
}

export interface AccountReplacementAlias {
  candidateAccountId: string;
  survivingAccountId: string;
  createdAt: string;
  expiresAt: string;
}

export interface RetiredBrowserProfile {
  profileId: string;
  survivingAccountId: string;
  retiredAt: string;
  removeAfter: string;
  reason:
    | "replaced_after_duplicate_login"
    | "account_deleted"
    | "browser_switched"
    | "browser_switch_cancelled";
}

export {
  assertPlatformAccountSnapshot,
  InvalidPlatformAccountSnapshotError,
  PlatformAccount,
  PlatformAccountIdentityChangeError,
} from "./platform-account.js";
export type {
  AccountProfileReplacementCommand,
  AccountProfileReplacementResult,
  PlatformAccountDetection,
} from "./platform-account.js";
