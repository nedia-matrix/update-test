import {
  assertPlatformAccountSnapshot,
  type AccountReplacementAlias,
  platformAccountInfoKeys,
  platformAccountLifecycles,
  platformAccountStatuses,
  type PlatformAccountInfoItem,
  type PlatformAccountLifecycle,
  type PlatformAccountStatus,
  type PlatformAccountSnapshot,
  type RetiredBrowserProfile,
} from "@nedia-matrix/account-management";

export interface AccountStoreState {
  schemaVersion: 1;
  accounts: PlatformAccountSnapshot[];
  replacementAliases: AccountReplacementAlias[];
  retiredProfiles: RetiredBrowserProfile[];
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalNullableCount(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function parseAccountInfo(value: unknown): PlatformAccountInfoItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const keys = new Set<string>();
  const items: PlatformAccountInfoItem[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const { key, value: itemValue } = candidate as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      !platformAccountInfoKeys.some((allowed) => allowed === key) ||
      keys.has(key) ||
      !(
        (typeof itemValue === "string" && itemValue.trim()) ||
        (typeof itemValue === "number" &&
          Number.isFinite(itemValue) &&
          itemValue >= 0)
      )
    ) {
      return null;
    }
    keys.add(key);
    items.push({
      key: key as PlatformAccountInfoItem["key"],
      value: itemValue as string | number,
    });
  }
  return items;
}

function parseAccount(value: unknown): PlatformAccountSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const account = value as Partial<PlatformAccountSnapshot>;
  const legacyAccount = value as {
    followerCount?: unknown;
    contentCount?: unknown;
  };
  const parsedAccountInfo = parseAccountInfo(account.accountInfo);
  const legacyPartition = (value as { partition?: unknown }).partition;
  const profileId =
    typeof account.profileId === "string"
      ? account.profileId
      : typeof legacyPartition === "string"
        ? legacyPartition.replace(/^persist:/, "")
        : null;
  const lifecycle = platformAccountLifecycles.some(
    (candidate) => candidate === account.lifecycle,
  )
    ? account.lifecycle
    : account.externalAccountId === null
      ? "pending_identity"
      : "active";
  const identityScheme =
    account.identityScheme === undefined ? null : account.identityScheme;
  const profileSyncedAt =
    account.profileSyncedAt === undefined ? null : account.profileSyncedAt;
  if (
    typeof account.id !== "string" ||
    typeof account.platformId !== "string" ||
    profileId === null ||
    typeof account.displayName !== "string" ||
    !isNullableString(identityScheme) ||
    !isNullableString(account.externalAccountId) ||
    !isNullableString(account.nickname) ||
    !isNullableString(account.avatarUrl) ||
    !isNullableString(profileSyncedAt) ||
    parsedAccountInfo === null ||
    !isOptionalNullableCount(legacyAccount.followerCount) ||
    !isOptionalNullableCount(legacyAccount.contentCount) ||
    !platformAccountStatuses.some((status) => status === account.status) ||
    !isNullableString(account.lastVerifiedAt) ||
    typeof account.createdAt !== "string" ||
    typeof account.updatedAt !== "string" ||
    (lifecycle === "active" && account.externalAccountId === null)
  ) {
    return null;
  }

  const {
    partition: _legacyPartition,
    followerCount: _legacyFollowerCount,
    contentCount: _legacyContentCount,
    ...currentFields
  } = value as Record<string, unknown>;
  const accountInfo =
    account.accountInfo === undefined
      ? [
          ...(typeof legacyAccount.followerCount === "number"
            ? [
                {
                  key: "follower_count" as const,
                  value: legacyAccount.followerCount,
                },
              ]
            : []),
          ...(typeof legacyAccount.contentCount === "number"
            ? [
                {
                  key: "content_count" as const,
                  value: legacyAccount.contentCount,
                },
              ]
            : []),
        ]
      : parsedAccountInfo;
  const normalized: PlatformAccountSnapshot = {
    ...currentFields,
    id: account.id,
    platformId: account.platformId,
    profileId,
    lifecycle: lifecycle as PlatformAccountLifecycle,
    displayName: account.displayName,
    identityScheme,
    externalAccountId: account.externalAccountId,
    nickname: account.nickname,
    avatarUrl: account.avatarUrl,
    accountInfo,
    profileSyncedAt,
    status: account.status as PlatformAccountStatus,
    lastVerifiedAt: account.lastVerifiedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
  try {
    assertPlatformAccountSnapshot(normalized);
  } catch {
    return null;
  }
  return normalized;
}

export function parseStoredAccounts(value: unknown): PlatformAccountSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseAccount)
    .filter((account): account is PlatformAccountSnapshot => account !== null);
}

function parseReplacementAlias(value: unknown): AccountReplacementAlias | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<AccountReplacementAlias>;
  if (
    typeof candidate.candidateAccountId !== "string" ||
    typeof candidate.survivingAccountId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.expiresAt !== "string"
  ) {
    return null;
  }
  return candidate as AccountReplacementAlias;
}

function parseRetiredProfile(value: unknown): RetiredBrowserProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<RetiredBrowserProfile>;
  if (
    typeof candidate.profileId !== "string" ||
    typeof candidate.survivingAccountId !== "string" ||
    typeof candidate.retiredAt !== "string" ||
    typeof candidate.removeAfter !== "string" ||
    (candidate.reason !== "replaced_after_duplicate_login" &&
      candidate.reason !== "account_deleted" &&
      candidate.reason !== "browser_switched" &&
      candidate.reason !== "browser_switch_cancelled")
  ) {
    return null;
  }
  return candidate as RetiredBrowserProfile;
}

export function parseAccountState(value: unknown): AccountStoreState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.accounts)) {
    return null;
  }
  return {
    schemaVersion: 1,
    accounts: parseStoredAccounts(candidate.accounts),
    replacementAliases: Array.isArray(candidate.replacementAliases)
      ? candidate.replacementAliases
          .map(parseReplacementAlias)
          .filter((alias): alias is AccountReplacementAlias => alias !== null)
      : [],
    retiredProfiles: Array.isArray(candidate.retiredProfiles)
      ? candidate.retiredProfiles
          .map(parseRetiredProfile)
          .filter(
            (profile): profile is RetiredBrowserProfile => profile !== null,
          )
      : [],
  };
}
