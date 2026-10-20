import {
  assertPlatformSettings,
  type PlatformSettings,
} from "@nedia-matrix/platform-sdk";
import type {
  AccountReplacementAlias,
  PlatformAccountSnapshot,
  PlatformAccountInfoItem,
  RetiredBrowserProfile,
} from "./index.js";
import { platformAccountInfoKeys } from "./account-info.js";
import { platformAccountLifecycles, platformAccountStatuses } from "./index.js";

export interface PlatformAccountDetection {
  readonly status: PlatformAccountSnapshot["status"];
  readonly identityScheme?: string;
  readonly externalAccountId?: string;
  readonly nickname?: string;
  readonly avatarUrl?: string | null;
}

export interface AccountProfileReplacementCommand {
  readonly identity: {
    readonly platformId: string;
    readonly identityScheme: string;
    readonly externalAccountId: string;
  };
  readonly nickname: string;
  readonly avatarUrl: string | null;
  readonly replacedAt: string;
  readonly aliasExpiresAt: string;
  readonly removeRetiredProfileAfter: string;
}

export interface AccountProfileReplacementResult {
  readonly survivingAccount: PlatformAccountSnapshot;
  readonly replacementAlias: AccountReplacementAlias;
  readonly retiredProfile: RetiredBrowserProfile;
}

export class InvalidPlatformAccountSnapshotError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlatformAccountSnapshotError";
  }
}

export class PlatformAccountIdentityChangeError extends Error {
  constructor() {
    super("Established platform account identity cannot change implicitly");
    this.name = "PlatformAccountIdentityChangeError";
  }
}

/**
 * Runtime aggregate used at application boundaries. The public snapshot shape
 * remains a plain object until the context Package migration is complete.
 */
export class PlatformAccount {
  private snapshot: PlatformAccountSnapshot;

  private constructor(snapshot: PlatformAccountSnapshot) {
    assertPlatformAccountSnapshot(snapshot);
    this.snapshot = clone(snapshot);
  }

  static createPending(input: {
    id: string;
    platformId: string;
    profileId: string;
    platformDisplayName: string;
    occurredAt: string;
  }): PlatformAccount {
    assertNonEmptyString(input.id, "Account ID");
    assertNonEmptyString(input.platformId, "Account platform ID");
    assertNonEmptyString(input.profileId, "Account profile ID");
    assertNonEmptyString(
      input.platformDisplayName,
      "Account platform display name",
    );
    assertTimestamp(input.occurredAt, "Account creation time");
    return PlatformAccount.rehydrate({
      id: input.id,
      platformId: input.platformId,
      profileId: input.profileId,
      lifecycle: "pending_identity",
      displayName: `${input.platformDisplayName}账号`,
      identityScheme: null,
      externalAccountId: null,
      nickname: null,
      avatarUrl: null,
      accountInfo: [],
      profileSyncedAt: null,
      status: "login_required",
      lastVerifiedAt: null,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    });
  }

  static rehydrate(snapshot: PlatformAccountSnapshot): PlatformAccount {
    return new PlatformAccount({
      ...snapshot,
      // Records written before account-profile sync was introduced have no
      // ownership timestamp. Treat them as never synchronized.
      profileSyncedAt: snapshot.profileSyncedAt ?? null,
    });
  }

  get id(): string {
    return this.snapshot.id;
  }

  get platformId(): string {
    return this.snapshot.platformId;
  }

  get profileId(): string {
    return this.snapshot.profileId;
  }

  get lifecycle(): PlatformAccountSnapshot["lifecycle"] {
    return this.snapshot.lifecycle;
  }

  get status(): PlatformAccountSnapshot["status"] {
    return this.snapshot.status;
  }

  get identity(): {
    platformId: string;
    identityScheme: string;
    externalAccountId: string;
  } | null {
    if (
      this.snapshot.lifecycle !== "active" ||
      this.snapshot.identityScheme === null ||
      this.snapshot.externalAccountId === null
    ) {
      return null;
    }
    return {
      platformId: this.snapshot.platformId,
      identityScheme: this.snapshot.identityScheme,
      externalAccountId: this.snapshot.externalAccountId,
    };
  }

  toSnapshot(): PlatformAccountSnapshot {
    return clone(this.snapshot);
  }

  matchesIdentity(identity: {
    platformId: string;
    identityScheme: string;
    externalAccountId: string;
  }): boolean {
    return (
      this.snapshot.lifecycle === "active" &&
      this.snapshot.platformId === identity.platformId &&
      this.snapshot.externalAccountId === identity.externalAccountId &&
      (this.snapshot.identityScheme === null ||
        this.snapshot.identityScheme === identity.identityScheme)
    );
  }

  detectedDifferentIdentity(detection: PlatformAccountDetection): boolean {
    return (
      detection.status === "authenticated" &&
      this.snapshot.lifecycle === "active" &&
      (detection.externalAccountId !== this.snapshot.externalAccountId ||
        (this.snapshot.identityScheme !== null &&
          detection.identityScheme !== this.snapshot.identityScheme))
    );
  }

  recordDetection(
    detection: PlatformAccountDetection,
    occurredAt: string,
  ): void {
    this.updateFromDetection(detection, occurredAt, false);
  }

  refreshIdentity(
    detection: PlatformAccountDetection,
    occurredAt: string,
  ): void {
    if (detection.status !== "authenticated") {
      throw new TypeError(
        "Identity refresh requires an authenticated detection",
      );
    }
    this.updateFromDetection(detection, occurredAt, true);
  }

  setSettings(settings: PlatformSettings, occurredAt: string): void {
    assertPlatformSettings(settings);
    assertTimestamp(occurredAt, "Settings change time");
    const next = {
      ...this.snapshot,
      settings: { ...settings },
      updatedAt: occurredAt,
    };
    assertPlatformAccountSnapshot(next);
    this.snapshot = next;
  }

  updateProfile(
    accountInfo: readonly PlatformAccountInfoItem[],
    occurredAt: string,
  ): void {
    if (this.snapshot.lifecycle !== "active") {
      throw new TypeError("Account profile sync requires an active account");
    }
    assertAccountInfo(accountInfo);
    assertTimestamp(occurredAt, "Profile sync time");
    const merged = new Map(
      (this.snapshot.accountInfo ?? []).map((item) => [item.key, item]),
    );
    for (const item of accountInfo) merged.set(item.key, clone(item));
    const nextSnapshot: PlatformAccountSnapshot = {
      ...this.snapshot,
      accountInfo: [...merged.values()],
      profileSyncedAt: occurredAt,
      updatedAt: occurredAt,
    };
    assertPlatformAccountSnapshot(nextSnapshot);
    this.snapshot = nextSnapshot;
  }

  updateContentCount(contentCount: number, occurredAt: string): void {
    if (this.snapshot.lifecycle !== "active") {
      throw new TypeError("Content count update requires an active account");
    }
    if (!Number.isSafeInteger(contentCount) || contentCount < 0) {
      throw new TypeError("Content count must be a non-negative safe integer");
    }
    assertTimestamp(occurredAt, "Content count observation time");
    const merged = new Map(
      (this.snapshot.accountInfo ?? []).map((item) => [item.key, item]),
    );
    merged.set("content_count", { key: "content_count", value: contentCount });
    const nextSnapshot: PlatformAccountSnapshot = {
      ...this.snapshot,
      accountInfo: [...merged.values()],
      updatedAt: occurredAt,
    };
    assertPlatformAccountSnapshot(nextSnapshot);
    this.snapshot = nextSnapshot;
  }

  adoptCandidateProfile(
    candidate: PlatformAccount,
    command: AccountProfileReplacementCommand,
  ): AccountProfileReplacementResult {
    if (candidate.lifecycle !== "pending_identity") {
      throw new TypeError("Candidate account is no longer pending identity");
    }
    if (!this.matchesIdentity(command.identity)) {
      throw new TypeError("Surviving account identity changed");
    }
    if (candidate.profileId === this.profileId) {
      throw new TypeError("Candidate and surviving account share a profile");
    }

    const retiredProfile: RetiredBrowserProfile = {
      profileId: this.profileId,
      survivingAccountId: this.id,
      retiredAt: command.replacedAt,
      removeAfter: command.removeRetiredProfileAfter,
      reason: "replaced_after_duplicate_login",
    };
    const replacementAlias: AccountReplacementAlias = {
      candidateAccountId: candidate.id,
      survivingAccountId: this.id,
      createdAt: command.replacedAt,
      expiresAt: command.aliasExpiresAt,
    };

    const nextSnapshot: PlatformAccountSnapshot = {
      ...this.snapshot,
      profileId: candidate.profileId,
      lifecycle: "active",
      identityScheme: command.identity.identityScheme,
      externalAccountId: command.identity.externalAccountId,
      displayName: command.nickname,
      nickname: command.nickname,
      avatarUrl: command.avatarUrl,
      status: "authenticated",
      lastVerifiedAt: command.replacedAt,
      updatedAt: command.replacedAt,
    };
    assertPlatformAccountSnapshot(nextSnapshot);
    this.snapshot = nextSnapshot;
    return {
      survivingAccount: this.toSnapshot(),
      replacementAlias,
      retiredProfile,
    };
  }

  switchBrowserProfile(input: {
    expectedProfileId: string;
    profileId: string;
    identity: {
      platformId: string;
      identityScheme: string;
      externalAccountId: string;
    };
    nickname: string;
    avatarUrl: string | null;
    occurredAt: string;
  }): PlatformAccountSnapshot {
    const identity = this.identity;
    if (
      !identity ||
      identity.platformId !== input.identity.platformId ||
      identity.identityScheme !== input.identity.identityScheme ||
      identity.externalAccountId !== input.identity.externalAccountId ||
      this.profileId !== input.expectedProfileId
    )
      throw new TypeError("Browser switch account or identity changed");
    assertNonEmptyString(input.profileId, "Target profile ID");
    if (input.profileId === this.profileId)
      throw new TypeError("Browser switch requires a new profile");
    assertNonEmptyString(input.nickname, "Account nickname");
    const next = {
      ...this.snapshot,
      profileId: input.profileId,
      displayName: input.nickname,
      nickname: input.nickname,
      avatarUrl: input.avatarUrl,
      status: "authenticated" as const,
      lastVerifiedAt: input.occurredAt,
      updatedAt: input.occurredAt,
    };
    assertPlatformAccountSnapshot(next);
    this.snapshot = next;
    return this.toSnapshot();
  }

  private updateFromDetection(
    detection: PlatformAccountDetection,
    occurredAt: string,
    allowIdentityChange: boolean,
  ): void {
    assertDetection(detection);
    assertTimestamp(occurredAt, "Account verification time");
    if (!allowIdentityChange && this.detectedDifferentIdentity(detection)) {
      throw new PlatformAccountIdentityChangeError();
    }
    const nextSnapshot: PlatformAccountSnapshot = {
      ...this.snapshot,
      ...(detection.status === "authenticated"
        ? {
            lifecycle: "active" as const,
            displayName: detection.nickname!,
            identityScheme: detection.identityScheme!,
            externalAccountId: detection.externalAccountId!,
            nickname: detection.nickname!,
            avatarUrl: detection.avatarUrl ?? null,
          }
        : {}),
      status: detection.status,
      lastVerifiedAt: occurredAt,
      updatedAt: occurredAt,
    };
    assertPlatformAccountSnapshot(nextSnapshot);
    this.snapshot = nextSnapshot;
  }
}

export function assertPlatformAccountSnapshot(
  snapshot: PlatformAccountSnapshot,
): PlatformAccountSnapshot {
  try {
    assertSnapshotShape(snapshot);
    if (snapshot.lifecycle === "pending_identity") {
      if (
        snapshot.identityScheme !== null ||
        snapshot.externalAccountId !== null ||
        snapshot.status === "authenticated"
      ) {
        throw new TypeError("Pending account cannot have a stable identity");
      }
    } else if (snapshot.externalAccountId === null) {
      throw new TypeError("Active account must have an external identity");
    }
    if (
      Date.parse(snapshot.updatedAt) < Date.parse(snapshot.createdAt) ||
      (snapshot.profileSyncedAt !== null &&
        Date.parse(snapshot.profileSyncedAt) >
          Date.parse(snapshot.updatedAt)) ||
      (snapshot.lastVerifiedAt !== null &&
        Date.parse(snapshot.lastVerifiedAt) > Date.parse(snapshot.updatedAt))
    ) {
      throw new TypeError("Account timestamps are out of order");
    }
  } catch (error) {
    if (error instanceof InvalidPlatformAccountSnapshotError) throw error;
    throw new InvalidPlatformAccountSnapshotError(
      error instanceof Error
        ? error.message
        : "Invalid platform account snapshot",
    );
  }
  return snapshot;
}

function assertSnapshotShape(snapshot: PlatformAccountSnapshot): void {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Platform account snapshot must be an object");
  }
  assertNonEmptyString(snapshot.id, "Account ID");
  assertNonEmptyString(snapshot.platformId, "Account platform ID");
  assertNonEmptyString(snapshot.profileId, "Account profile ID");
  if (snapshot.settings !== undefined)
    assertPlatformSettings(snapshot.settings);
  assertNonEmptyString(snapshot.displayName, "Account display name");
  if (!platformAccountLifecycles.includes(snapshot.lifecycle)) {
    throw new TypeError("Invalid account lifecycle");
  }
  if (!platformAccountStatuses.includes(snapshot.status)) {
    throw new TypeError("Invalid account status");
  }
  assertNullableNonEmptyString(
    snapshot.identityScheme,
    "Account identity scheme",
  );
  assertNullableNonEmptyString(
    snapshot.externalAccountId,
    "External account ID",
  );
  assertNullableString(snapshot.nickname, "Account nickname");
  assertNullableString(snapshot.avatarUrl, "Account avatar URL");
  assertAccountInfo(snapshot.accountInfo ?? []);
  assertNullableTimestamp(snapshot.profileSyncedAt, "Profile sync time");
  assertNullableTimestamp(snapshot.lastVerifiedAt, "Account verification time");
  assertTimestamp(snapshot.createdAt, "Account creation time");
  assertTimestamp(snapshot.updatedAt, "Account update time");
}

function assertDetection(detection: PlatformAccountDetection): void {
  if (!detection || !platformAccountStatuses.includes(detection.status)) {
    throw new TypeError("Invalid account detection");
  }
  if (detection.status !== "authenticated") return;
  assertNonEmptyString(detection.identityScheme, "Account identity scheme");
  assertNonEmptyString(detection.externalAccountId, "External account ID");
  assertNonEmptyString(detection.nickname, "Account nickname");
  assertNullableString(detection.avatarUrl ?? null, "Account avatar URL");
}

function assertAccountInfo(value: readonly PlatformAccountInfoItem[]): void {
  const keys = new Set<PlatformAccountInfoItem["key"]>();
  for (const item of value) {
    if (
      !item ||
      !platformAccountInfoKeys.includes(item.key) ||
      keys.has(item.key) ||
      !(
        (typeof item.value === "string" && item.value.trim().length > 0) ||
        (typeof item.value === "number" &&
          Number.isFinite(item.value) &&
          item.value >= 0)
      )
    ) {
      throw new TypeError("Invalid account info");
    }
    keys.add(item.key);
  }
}

function assertNullableString(value: unknown, name: string): void {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${name} must be a string or null`);
  }
}

function assertNullableNonEmptyString(value: unknown, name: string): void {
  if (value !== null) assertNonEmptyString(value, name);
}

function assertNonEmptyString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertNullableTimestamp(value: unknown, name: string): void {
  if (value !== null) assertTimestamp(value, name);
}

function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a timestamp`);
  }
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        clone(entry),
      ]),
    ) as T;
  }
  return value;
}
