import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";
import { RuntimeAccessError, type RuntimeAccess } from "./runtime-access.js";

/** Runtime-only policy; desktop IPC continues to use the original use cases. */
export class RuntimeAccountAccess {
  constructor(
    private readonly application: NediaMatrixUseCases,
    private readonly access?: RuntimeAccess,
  ) {}
  allowed(accountId: string): boolean {
    const account = this.application.accounts
      .list()
      .find((candidate) => candidate.id === accountId);
    // Legacy servers without account authorization retain historical replay semantics.
    if (!account) return !this.access;
    return (
      (!this.access || this.access.allowed(accountId)) &&
      this.application
        .platformSummaries()
        .some(
          (platform) =>
            platform.id === account.platformId && !platform.unavailableReason,
        )
    );
  }
  assert(accountId: string): void {
    if (!this.allowed(accountId)) throw new RuntimeAccessError();
  }
  byId(accountId: string): void {
    let resolvedId: string;
    try {
      resolvedId = this.application.accounts.resolve({ accountId }).account.id;
    } catch {
      if (this.access) throw new RuntimeAccessError();
      return;
    }
    this.assert(resolvedId);
  }
  byIdentity(platformId: string, externalAccountId: string): void {
    const accounts = this.application.accounts
      .list()
      .filter(
        (account) =>
          account.platformId === platformId &&
          account.externalAccountId === externalAccountId,
      );
    if (!accounts.length && this.access) throw new RuntimeAccessError();
    for (const account of accounts) this.assert(account.id);
  }
}
