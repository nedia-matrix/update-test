import type {
  AccountReplacementAlias,
  CanonicalAccountIdentity,
  PlatformAccountSnapshot,
  PlatformAccountInfoItem,
  RetiredBrowserProfile,
} from "../domain/index.js";

export interface PlatformAccountView {
  readonly id: string;
  readonly platformId: string;
  readonly settings?: import("@nedia-matrix/platform-sdk").PlatformSettings;
  readonly profileId: string;
  readonly lifecycle: PlatformAccountSnapshot["lifecycle"];
  readonly displayName: string;
  readonly identityScheme: string | null;
  readonly externalAccountId: string | null;
  readonly nickname: string | null;
  readonly avatarUrl: string | null;
  readonly accountInfo: readonly PlatformAccountInfoItem[];
  readonly profileSyncedAt: string | null;
  readonly status: PlatformAccountSnapshot["status"];
  readonly lastVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPlatformAccountView(
  snapshot: PlatformAccountSnapshot,
): PlatformAccountView {
  return {
    id: snapshot.id,
    platformId: snapshot.platformId,
    ...(snapshot.settings ? { settings: { ...snapshot.settings } } : {}),
    profileId: snapshot.profileId,
    lifecycle: snapshot.lifecycle,
    displayName: snapshot.displayName,
    identityScheme: snapshot.identityScheme,
    externalAccountId: snapshot.externalAccountId,
    nickname: snapshot.nickname,
    avatarUrl: snapshot.avatarUrl,
    accountInfo: [...(snapshot.accountInfo ?? [])],
    profileSyncedAt: snapshot.profileSyncedAt,
    status: snapshot.status,
    lastVerifiedAt: snapshot.lastVerifiedAt,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

export interface CreatePlatformAccountRequest {
  platformId: string;
}

export interface OpenPlatformLoginRequest {
  accountId: string;
  loginEntryId: string;
}

export interface OpenPlatformLoginResult {
  profileId: string;
}

export interface PlatformAccountRequest {
  accountId: string;
}

export interface OpenPlatformAccountResult {
  sessionId: string;
  profileId: string;
}

export type DetectPlatformSessionResult =
  | {
      status: "authenticated";
      identityScheme: string;
      externalAccountId: string;
      nickname: string;
      avatarUrl: string | null;
      source: "api" | "response" | "dom";
    }
  | {
      status: "login_required";
      source: "api" | "response" | "dom";
    }
  | { status: "unknown"; reason: string };

export interface SetAccountSettingsRequest {
  accountId: string;
  settings: import("@nedia-matrix/platform-sdk").PlatformSettings;
}
export interface AccountUseCases {
  setSettings?(
    request: SetAccountSettingsRequest,
  ): Promise<PlatformAccountView>;
  list(): PlatformAccountView[];
  resolve(request: PlatformAccountRequest): ResolvedPlatformAccount;
  resolveByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
  }): PlatformAccountSnapshot;
  verifyByExternalIdentity(request: {
    platformId: string;
    externalAccountId: string;
  }): Promise<PlatformAccountSnapshot>;
  create(request: CreatePlatformAccountRequest): PlatformAccountView;
  openLogin(
    request: OpenPlatformLoginRequest,
  ): Promise<OpenPlatformLoginResult>;
  open(request: PlatformAccountRequest): Promise<OpenPlatformAccountResult>;
  refresh(
    request: PlatformAccountRequest,
  ): Promise<DetectPlatformSessionResult>;
  refreshProfile(request: PlatformAccountRequest): Promise<PlatformAccountView>;
  verify(request: PlatformAccountRequest): Promise<DetectPlatformSessionResult>;
  remove(request: PlatformAccountRequest): Promise<void>;
  cleanupRetiredProfiles(): Promise<void>;
}

export interface ResolvedPlatformAccount {
  account: PlatformAccountSnapshot;
  replacementAlias?: AccountReplacementAlias;
}

export interface ReplaceCandidateProfileCommand {
  candidateAccountId: string;
  survivingAccountId: string;
  identity: CanonicalAccountIdentity;
  nickname: string;
  avatarUrl: string | null;
  replacedAt: string;
  aliasExpiresAt: string;
  removeRetiredProfileAfter: string;
}

export interface ReplaceCandidateProfileResult {
  survivingAccount: PlatformAccountSnapshot;
  replacementAlias: AccountReplacementAlias;
  retiredProfile: RetiredBrowserProfile;
}

export class AccountIdentityConflictError extends Error {
  constructor(readonly existingAccountId: string) {
    super("Platform account identity already exists");
  }
}
