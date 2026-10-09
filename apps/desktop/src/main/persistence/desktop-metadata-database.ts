import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  migrateMetadataSchema,
  type MetadataMigrationObserver,
} from "./schema-migrations.js";

export class DesktopMetadataDatabase {
  readonly connection: DatabaseSync;
  private closed = false;

  constructor(
    readonly filename: string,
    observer?: MetadataMigrationObserver,
  ) {
    const existed = existsSync(filename);
    mkdirSync(dirname(filename), { recursive: true });
    this.connection = new DatabaseSync(filename);
    try {
      this.connection.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250;");
      migrateMetadataSchema(this, existed, observer);
      this.connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (
        this.connection.prepare("PRAGMA journal_mode").get()?.journal_mode !==
          "wal" ||
        this.connection.prepare("PRAGMA synchronous").get()?.synchronous !==
          2 ||
        this.connection.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1
      ) {
        throw new Error("Required metadata durability settings unavailable");
      }
      this.checkIntegrity();
      observer?.report("persistence.sqlite.integrity_verified");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    if (this.connection.isTransaction)
      throw new Error("Nested metadata transaction");
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("Metadata transactions must be synchronous");
      }
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  checkIntegrity(): void {
    if (
      this.connection.prepare("PRAGMA integrity_check").get()
        ?.integrity_check !== "ok" ||
      this.connection.prepare("PRAGMA foreign_key_check").all().length
    ) {
      throw new Error("Metadata integrity check failed");
    }
  }

  backup(destination: string): void {
    this.connection.prepare("VACUUM INTO ?").run(destination);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      if (
        snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check !==
          "ok" ||
        snapshot.prepare("PRAGMA foreign_key_check").all().length
      ) {
        throw new Error("Metadata backup verification failed");
      }
    } finally {
      snapshot.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
  }
}
