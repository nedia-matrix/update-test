import { accountSubmissionMode } from "@nedia-matrix/platform-sdk";
import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";

export function toRuntimeAccountSession(
  account: PlatformAccountSnapshot,
  replacementAlias?: { candidateAccountId: string },
) {
  return {
    runtimeAccountId: account.id,
    remoteSubmissionMode: accountSubmissionMode(account),
    settings: { ...account.settings },
    platform: account.platformId,
    loggedIn: account.status === "authenticated",
    status:
      account.status === "authenticated"
        ? ("connected" as const)
        : account.status === "login_required"
          ? ("expired" as const)
          : ("unknown" as const),
    nickname: account.nickname,
    externalAccountId: account.externalAccountId,
    avatarUrl: account.avatarUrl,
    accountInfo: account.accountInfo ?? [],
    lastVerifiedAt: account.lastVerifiedAt,
    ...(replacementAlias
      ? {
          resolution: {
            kind: "existing_account_profile_replaced" as const,
            requestedRuntimeAccountId: replacementAlias.candidateAccountId,
          },
        }
      : {}),
  };
}
