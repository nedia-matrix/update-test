import { isDeepStrictEqual } from "node:util";
import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";
import { AccountStateRepository } from "./account-state-repository.js";
import {
  parseAccountState,
  type AccountStoreState,
} from "./account-state-codec.js";

export function validateAccountState(state: AccountStoreState): void {
  if (!isDeepStrictEqual(parseAccountState(state), state))
    throw new Error("Invalid account metadata");
  const ids = new Set<string>();
  for (const account of state.accounts) {
    if (ids.has(account.id)) throw new Error("Duplicate account ID");
    ids.add(account.id);
    if (
      account.lifecycle === "active" &&
      account.externalAccountId !== null &&
      state.accounts.some(
        (other) =>
          other.id !== account.id &&
          other.lifecycle === "active" &&
          other.platformId === account.platformId &&
          other.externalAccountId === account.externalAccountId &&
          (other.identityScheme === null ||
            account.identityScheme === null ||
            other.identityScheme === account.identityScheme),
      )
    ) {
      throw new Error("Duplicate account identity");
    }
  }
  const candidates = new Set<string>();
  for (const alias of state.replacementAliases) {
    if (
      candidates.has(alias.candidateAccountId) ||
      ids.has(alias.candidateAccountId) ||
      !ids.has(alias.survivingAccountId)
    )
      throw new Error("Invalid replacement alias reference");
    candidates.add(alias.candidateAccountId);
  }
  if (
    new Set(state.retiredProfiles.map((profile) => profile.profileId)).size !==
    state.retiredProfiles.length
  )
    throw new Error("Duplicate retired profile");
}

export class SqliteAccountRepository extends AccountStateRepository {
  constructor(private readonly database: DesktopMetadataDatabase) {
    super({
      get: (key) => (key === "state" ? readAccountState(database) : undefined),
      set: (_key, state) => {
        if (database.connection.isTransaction)
          writeAccountState(database, state);
        else database.transaction(() => writeAccountState(database, state));
      },
    });
  }
  importState(state: AccountStoreState): void {
    writeAccountState(this.database, state);
  }

  removeWithProfileIntent(accountId: string, now = new Date()): void {
    this.database.transaction(() => {
      const account = this.require(accountId);
      this.remove(accountId);
      const profile = {
        profileId: account.profileId,
        survivingAccountId: account.id,
        retiredAt: now.toISOString(),
        removeAfter: now.toISOString(),
        reason: "account_deleted",
      };
      this.database.connection
        .prepare(
          "INSERT INTO retired_browser_profiles VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        )
        .run(account.profileId, JSON.stringify(profile));
    });
  }
}

function readAccountState(
  database: DesktopMetadataDatabase,
): AccountStoreState {
  const sql = database.connection;
  const accounts = sql
    .prepare("SELECT * FROM platform_accounts")
    .all()
    .map((row) => {
      const account = JSON.parse(String(row.record));
      if (
        account.id !== row.id ||
        account.profileId !== row.profile_id ||
        account.platformId !== row.platform_id ||
        account.identityScheme !== row.identity_scheme ||
        account.externalAccountId !== row.external_account_id ||
        account.lifecycle !== row.lifecycle
      )
        throw new Error("Account index mismatch");
      return account;
    });
  const aliases = sql
    .prepare("SELECT * FROM account_replacement_aliases")
    .all()
    .map((row) => {
      const alias = JSON.parse(String(row.record));
      if (alias.candidateAccountId !== row.id)
        throw new Error("Alias index mismatch");
      return alias;
    });
  const retired = sql
    .prepare("SELECT * FROM retired_browser_profiles")
    .all()
    .map((row) => {
      const profile = JSON.parse(String(row.record));
      if (profile.profileId !== row.id)
        throw new Error("Retired profile index mismatch");
      return profile;
    });
  const storedState = {
    schemaVersion: 1,
    accounts,
    replacementAliases: aliases,
    retiredProfiles: retired,
  } as const;
  const state = parseAccountState(storedState);
  if (
    !state ||
    state.accounts.length !== accounts.length ||
    state.replacementAliases.length !== aliases.length ||
    state.retiredProfiles.length !== retired.length
  ) {
    throw new Error("Invalid account metadata");
  }
  validateAccountState(state);
  return state;
}

function writeAccountState(
  database: DesktopMetadataDatabase,
  state: AccountStoreState,
): void {
  validateAccountState(state);
  const sql = database.connection;
  const retained = new Set(state.accounts.map((account) => account.id));
  for (const row of sql.prepare("SELECT id FROM platform_accounts").all()) {
    if (!retained.has(String(row.id)))
      sql.prepare("DELETE FROM platform_accounts WHERE id=?").run(row.id!);
  }
  for (const account of state.accounts) {
    sql
      .prepare(
        `INSERT INTO platform_accounts VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, platform_id=excluded.platform_id,
      identity_scheme=excluded.identity_scheme, external_account_id=excluded.external_account_id,
      lifecycle=excluded.lifecycle, record=excluded.record`,
      )
      .run(
        account.id,
        account.profileId,
        account.platformId,
        account.identityScheme,
        account.externalAccountId,
        account.lifecycle,
        JSON.stringify(account),
      );
  }
  sql.exec(
    "DELETE FROM account_replacement_aliases; DELETE FROM retired_browser_profiles;",
  );
  for (const alias of state.replacementAliases)
    sql
      .prepare("INSERT INTO account_replacement_aliases VALUES (?, ?)")
      .run(alias.candidateAccountId, JSON.stringify(alias));
  for (const profile of state.retiredProfiles)
    sql
      .prepare("INSERT INTO retired_browser_profiles VALUES (?, ?)")
      .run(profile.profileId, JSON.stringify(profile));
}
