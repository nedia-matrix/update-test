import {
  acquireDesktopMetadataGate,
  verifySqliteIntegrity,
  vacuumMetadataInto,
} from "@nedia-matrix/metadata-maintenance";
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
  private readonly gate: { release(): void };

  constructor(
    readonly filename: string,
    observer?: MetadataMigrationObserver,
  ) {
    const existed = existsSync(filename);
    mkdirSync(dirname(filename), { recursive: true });
    this.gate = acquireDesktopMetadataGate(dirname(filename));
    try {
      this.connection = new DatabaseSync(filename);
    } catch (error) {
      this.gate.release();
      throw error;
    }
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
    verifySqliteIntegrity(this.connection);
  }

  backup(destination: string): void {
    vacuumMetadataInto(this.connection, destination);
  }

  close(): void {
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
    this.gate.release();
  }
}
