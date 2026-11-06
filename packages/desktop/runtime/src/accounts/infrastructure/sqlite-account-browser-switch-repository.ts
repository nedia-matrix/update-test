import {
  PlatformAccount,
  type AccountBrowserSwitchOperation,
  type AccountBrowserSwitchRepository,
  type CanonicalAccountIdentity,
  type PlatformAccountSnapshot,
} from "@nedia-matrix/account-management";
import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";
import { SqliteAccountRepository } from "./sqlite-account-repository.js";

const pending = (phase: AccountBrowserSwitchOperation["phase"]) =>
  phase === "preparing" || phase === "awaiting_login";

function sameIdentity(
  left: CanonicalAccountIdentity,
  right: CanonicalAccountIdentity,
): boolean {
  return (
    left.platformId === right.platformId &&
    left.identityScheme === right.identityScheme &&
    left.externalAccountId === right.externalAccountId
  );
}

function timestamp(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TypeError("Invalid browser switch timestamp");
}

function validate(operation: AccountBrowserSwitchOperation): void {
  for (const value of [
    operation.operationId,
    operation.accountId,
    operation.originalProfileId,
    operation.candidateProfileId,
    operation.identity?.platformId,
    operation.identity?.identityScheme,
    operation.identity?.externalAccountId,
  ]) {
    if (typeof value !== "string" || !value.trim())
      throw new TypeError("Invalid browser switch record");
  }
  if (
    !["system", "fingerprint"].includes(operation.targetProvider) ||
    !["preparing", "awaiting_login", "committed", "cancelled"].includes(
      operation.phase,
    ) ||
    operation.originalProfileId === operation.candidateProfileId
  )
    throw new TypeError("Invalid browser switch record");
  timestamp(operation.createdAt);
  timestamp(operation.updatedAt);
  if (Date.parse(operation.updatedAt) < Date.parse(operation.createdAt))
    throw new TypeError("Invalid browser switch chronology");
}

/** The commit marker, account reference and retirement intent share one SQLite transaction. */
export class SqliteAccountBrowserSwitchRepository implements AccountBrowserSwitchRepository {
  private readonly accounts: SqliteAccountRepository;

  constructor(private readonly database: DesktopMetadataDatabase) {
    this.accounts = new SqliteAccountRepository(database);
  }

  get(operationId: string): AccountBrowserSwitchOperation | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM account_browser_switches WHERE id=?")
      .get(operationId);
    if (!row) return undefined;
    const operation = JSON.parse(
      String(row.record),
    ) as AccountBrowserSwitchOperation;
    validate(operation);
    if (
      operation.operationId !== row.id ||
      operation.accountId !== row.account_id ||
      operation.candidateProfileId !== row.candidate_profile_id ||
      operation.phase !== row.phase
    )
      throw new Error("Browser switch index mismatch");
    return operation;
  }

  list(): AccountBrowserSwitchOperation[] {
    return this.database.connection
      .prepare("SELECT id FROM account_browser_switches ORDER BY id")
      .all()
      .map((row) => this.get(String(row.id))!);
  }

  pruneTerminal(olderThan: string): void {
    timestamp(olderThan);
    this.database.transaction(() => {
      for (const operation of this.list()) {
        if (
          !pending(operation.phase) &&
          Date.parse(operation.updatedAt) < Date.parse(olderThan)
        )
          this.database.connection
            .prepare("DELETE FROM account_browser_switches WHERE id=?")
            .run(operation.operationId);
      }
    });
  }

  create(operation: AccountBrowserSwitchOperation): void {
    validate(operation);
    if (
      operation.phase !== "preparing" ||
      operation.createdAt !== operation.updatedAt
    )
      throw new TypeError("Browser switch must start preparing");
    this.database.transaction(() => {
      this.requireOriginal(operation);
      if (
        this.accounts.hasProfileReference(operation.candidateProfileId) ||
        this.accounts
          .listRetiredProfiles()
          .some((profile) => profile.profileId === operation.candidateProfileId)
      )
        throw new TypeError("Browser switch profile is already owned");
      this.database.connection
        .prepare("INSERT INTO account_browser_switches VALUES (?, ?, ?, ?, ?)")
        .run(
          operation.operationId,
          operation.accountId,
          operation.candidateProfileId,
          operation.phase,
          JSON.stringify(operation),
        );
    });
  }

  markAwaitingLogin(
    operationId: string,
    occurredAt: string,
  ): AccountBrowserSwitchOperation {
    return this.database.transaction(() => {
      const operation = this.require(operationId);
      if (operation.phase === "awaiting_login") return operation;
      if (operation.phase !== "preparing")
        throw new TypeError("Browser switch is terminal");
      this.requireOriginal(operation);
      return this.save({
        ...operation,
        phase: "awaiting_login",
        updatedAt: occurredAt,
      });
    });
  }

  commit(
    input: Parameters<AccountBrowserSwitchRepository["commit"]>[0],
  ): PlatformAccountSnapshot {
    return this.database.transaction(() => {
      const operation = this.require(input.operationId);
      if (!sameIdentity(operation.identity, input.identity))
        throw new TypeError("Browser switch identity mismatch");
      // Repeated delivery is safe only while the committed result is still referenced.
      if (operation.phase === "committed") {
        const account = this.accounts.require(operation.accountId);
        if (
          account.profileId !== operation.candidateProfileId ||
          !this.matches(account, operation.identity)
        )
          throw new TypeError("Committed browser switch result changed");
        return account;
      }
      if (operation.phase !== "awaiting_login")
        throw new TypeError("Browser switch is not ready to commit");
      const account = this.requireOriginal(operation);
      if (
        this.accounts.hasProfileReference(operation.candidateProfileId) ||
        this.accounts
          .listRetiredProfiles()
          .some((profile) => profile.profileId === operation.candidateProfileId)
      )
        throw new TypeError("Browser switch profile is already owned");
      timestamp(input.removeRetiredProfileAfter);
      if (
        Date.parse(input.removeRetiredProfileAfter) <
        Date.parse(input.occurredAt)
      )
        throw new TypeError("Invalid retirement time");
      const replacement = PlatformAccount.rehydrate(
        account,
      ).switchBrowserProfile({
        expectedProfileId: operation.originalProfileId,
        profileId: operation.candidateProfileId,
        identity: input.identity,
        nickname: input.nickname,
        avatarUrl: input.avatarUrl,
        occurredAt: input.occurredAt,
      });
      this.accounts.put(replacement);
      this.retire(
        operation.originalProfileId,
        operation.accountId,
        input.occurredAt,
        input.removeRetiredProfileAfter,
        "browser_switched",
      );
      this.save({
        ...operation,
        phase: "committed",
        updatedAt: input.occurredAt,
      });
      return replacement;
    });
  }

  cancel(
    operationId: string,
    occurredAt: string,
  ): AccountBrowserSwitchOperation {
    return this.database.transaction(() => {
      const operation = this.require(operationId);
      if (!pending(operation.phase)) return operation;
      // Never reclaim a directory that another surviving account references.
      if (!this.accounts.hasProfileReference(operation.candidateProfileId))
        this.retire(
          operation.candidateProfileId,
          operation.accountId,
          occurredAt,
          occurredAt,
          "browser_switch_cancelled",
        );
      return this.save({
        ...operation,
        phase: "cancelled",
        updatedAt: occurredAt,
      });
    });
  }

  /** Called before accepting commands after restart. Committed operations never redo login. */
  recoverInterrupted(occurredAt: string): AccountBrowserSwitchOperation[] {
    timestamp(occurredAt);
    return this.list()
      .filter((operation) => pending(operation.phase))
      .map((operation) => this.cancel(operation.operationId, occurredAt));
  }

  private matches(
    account: PlatformAccountSnapshot,
    identity: CanonicalAccountIdentity,
  ): boolean {
    return (
      account.lifecycle === "active" &&
      account.platformId === identity.platformId &&
      account.identityScheme === identity.identityScheme &&
      account.externalAccountId === identity.externalAccountId
    );
  }

  private requireOriginal(
    operation: AccountBrowserSwitchOperation,
  ): PlatformAccountSnapshot {
    const account = this.accounts.require(operation.accountId);
    if (
      account.profileId !== operation.originalProfileId ||
      !this.matches(account, operation.identity)
    )
      throw new TypeError("Browser switch account or profile changed");
    if (
      this.database.connection
        .prepare(
          "SELECT id FROM platform_accounts WHERE profile_id=? AND id<>?",
        )
        .get(account.profileId, account.id)
    )
      throw new TypeError(
        "Browser switch original profile has multiple owners",
      );
    return account;
  }

  private require(operationId: string): AccountBrowserSwitchOperation {
    const operation = this.get(operationId);
    if (!operation) throw new TypeError("Browser switch does not exist");
    return operation;
  }

  private save(
    operation: AccountBrowserSwitchOperation,
  ): AccountBrowserSwitchOperation {
    validate(operation);
    this.database.connection
      .prepare(
        "UPDATE account_browser_switches SET phase=?, record=? WHERE id=?",
      )
      .run(operation.phase, JSON.stringify(operation), operation.operationId);
    return operation;
  }

  private retire(
    profileId: string,
    accountId: string,
    retiredAt: string,
    removeAfter: string,
    reason: "browser_switched" | "browser_switch_cancelled",
  ): void {
    this.database.connection
      .prepare("INSERT INTO retired_browser_profiles VALUES (?, ?)")
      .run(
        profileId,
        JSON.stringify({
          profileId,
          survivingAccountId: accountId,
          retiredAt,
          removeAfter,
          reason,
        }),
      );
  }
}
