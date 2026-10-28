import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";
import type {
  RuntimeAccessStore,
  StoredRuntimeSettings,
} from "./runtime-access.js";

export class SqliteRuntimeAccessStore implements RuntimeAccessStore {
  constructor(private readonly database: DesktopMetadataDatabase) {}
  read(): StoredRuntimeSettings | undefined {
    const row = this.database.connection
      .prepare("SELECT record FROM runtime_access_settings WHERE id=1")
      .get();
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  write(settings: StoredRuntimeSettings): void {
    this.database.connection
      .prepare(
        "INSERT INTO runtime_access_settings(id, record) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      )
      .run(JSON.stringify(settings));
  }
  allowed(accountId: string): boolean {
    return !this.database.connection
      .prepare(
        "SELECT account_id FROM runtime_disabled_accounts WHERE account_id=?",
      )
      .get(accountId);
  }
  setAllowed(accountId: string, allowed: boolean): void {
    if (allowed)
      this.database.connection
        .prepare("DELETE FROM runtime_disabled_accounts WHERE account_id=?")
        .run(accountId);
    else
      this.database.connection
        .prepare(
          "INSERT OR IGNORE INTO runtime_disabled_accounts(account_id) VALUES(?)",
        )
        .run(accountId);
  }
}
