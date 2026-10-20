import type { AccountBrowserProvider } from "@nedia-matrix/account-management";

export interface AccountBrowserSwitchStatus {
  operationId?: string;
  accountId: string;
  targetProvider: AccountBrowserProvider;
  phase:
    | "unchanged"
    | "preparing"
    | "awaiting_login"
    | "verifying"
    | "committing"
    | "cancelling"
    | "committed"
    | "cancelled"
    | "failed";
  error?: {
    code: "identity_mismatch" | "unavailable" | "cleanup" | "interrupted";
    message: string;
  };
}
export interface AccountBrowserState {
  accountId: string;
  provider: AccountBrowserProvider | null;
  externalKernel: boolean;
  version?: string;
  switchSupported: boolean;
  blockingReason?: string;
  operation?: AccountBrowserSwitchStatus;
}
export interface BeginAccountBrowserSwitchRequest {
  accountId: string;
  targetProvider: AccountBrowserProvider;
}
export interface AccountBrowserSwitchRequest {
  operationId: string;
}
