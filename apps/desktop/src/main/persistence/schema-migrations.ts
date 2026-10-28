import { randomUUID } from "node:crypto";
import { publicationSnapshot } from "./metadata-validation.js";
import type { DesktopMetadataDatabase } from "./desktop-metadata-database.js";

export const metadataSchemaVersion = 8;

export interface MetadataMigrationObserver {
  report(event: string, details?: Readonly<Record<string, unknown>>): void;
}

export function migrateMetadataSchema(
  database: DesktopMetadataDatabase,
  existed: boolean,
  observer?: MetadataMigrationObserver,
): void {
  const sql = database.connection;
  let version = Number(sql.prepare("PRAGMA user_version").get()?.user_version);
  if (version < 0 || version > metadataSchemaVersion)
    throw new Error("Unsupported metadata schema version");
  if (version === metadataSchemaVersion) {
    const migrations = sql
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    if (
      migrations.length !== metadataSchemaVersion ||
      migrations.some((migration, index) => migration.version !== index + 1)
    )
      throw new Error("Invalid metadata migration history");
    observer?.report("persistence.sqlite.schema_verified", { version });
    return;
  }
  if (version === 0) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v1",
      version: 1,
    });
    // An unversioned database with content is never an import destination.
    if (
      sql
        .prepare(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all().length
    ) {
      throw new Error("Unrecognized nonempty metadata database");
    }
    if (existed)
      database.backup(`${database.filename}.before-v1-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE legacy_imports (source TEXT PRIMARY KEY, present INTEGER NOT NULL CHECK(present IN (0,1)), digest TEXT, source_version TEXT NOT NULL, count INTEGER NOT NULL, completed_at TEXT NOT NULL) STRICT;
      CREATE TABLE platform_accounts (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, platform_id TEXT NOT NULL, identity_scheme TEXT, external_account_id TEXT, lifecycle TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
      CREATE UNIQUE INDEX account_identity ON platform_accounts(platform_id, identity_scheme, external_account_id) WHERE lifecycle='active' AND identity_scheme IS NOT NULL AND external_account_id IS NOT NULL;
      CREATE INDEX account_profile ON platform_accounts(profile_id);
      CREATE TABLE account_replacement_aliases (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
      CREATE TABLE retired_browser_profiles (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
      CREATE TABLE publications (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
      CREATE TABLE publication_observation_inbox (event_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES publications(id), sequence INTEGER NOT NULL CHECK(sequence >= 1), record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
      PRAGMA user_version=1;
    `);
      sql
        .prepare("INSERT INTO schema_migrations VALUES (1, ?, ?)")
        .run("Initial desktop metadata", new Date().toISOString());
    });
    version = 1;
    observer?.report("persistence.sqlite.migration_completed", { version });
  }
  if (version === 1) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v2",
      version: 2,
    });
    if (existed)
      database.backup(`${database.filename}.before-v2-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
        CREATE TABLE platform_contents (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
          external_content_id TEXT NOT NULL,
          record TEXT NOT NULL CHECK(json_valid(record)),
          UNIQUE(account_id, external_content_id)
        ) STRICT;
        CREATE INDEX platform_content_account ON platform_contents(account_id);
        CREATE TABLE platform_content_sync_runs (
          account_id TEXT PRIMARY KEY REFERENCES platform_accounts(id) ON DELETE CASCADE,
          record TEXT NOT NULL CHECK(json_valid(record))
        ) STRICT;
        PRAGMA user_version=2;
      `);
      sql
        .prepare("INSERT INTO schema_migrations VALUES (2, ?, ?)")
        .run(
          "Add platform content snapshots and sync runs",
          new Date().toISOString(),
        );
    });
    version = 2;
    observer?.report("persistence.sqlite.migration_completed", { version });
  }
  if (version === 2) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v3",
      version: 3,
    });
    if (existed)
      database.backup(`${database.filename}.before-v3-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
        DROP TABLE IF EXISTS runtime_account_bindings;
        DELETE FROM legacy_imports
          WHERE source = 'matrix-runtime-account-bindings';
        PRAGMA user_version=3;
      `);
      sql
        .prepare("INSERT INTO schema_migrations VALUES (3, ?, ?)")
        .run(
          "Remove Web account bindings from the local runtime",
          new Date().toISOString(),
        );
    });
    version = 3;
    observer?.report("persistence.sqlite.migration_completed", { version: 3 });
  }
  if (version === 3) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v4",
      version: 4,
    });
    if (existed)
      database.backup(`${database.filename}.before-v4-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
        CREATE TABLE publication_attention_resolution (
          publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
          resolution TEXT NOT NULL CHECK(resolution IN ('acknowledged_failure', 'recreated', 'confirmed_published', 'confirmed_not_published', 'dismissed')),
          resolved_at TEXT NOT NULL,
          manual_platform_content_id TEXT
        ) STRICT;
        CREATE TABLE publication_attention_history (
          id INTEGER PRIMARY KEY,
          publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
          resolution TEXT NOT NULL,
          resolved_at TEXT NOT NULL,
          manual_platform_content_id TEXT,
          reopened INTEGER NOT NULL CHECK(reopened IN (0,1))
        ) STRICT;
        CREATE INDEX publication_attention_history_publication ON publication_attention_history(publication_id, id);
        CREATE TABLE publication_query (
          publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
          platform_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          state TEXT NOT NULL,
          display_group TEXT NOT NULL,
          title TEXT,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX publication_query_updated ON publication_query(updated_at DESC, publication_id DESC);
        CREATE INDEX publication_query_group_updated ON publication_query(display_group, updated_at DESC, publication_id DESC);
        CREATE INDEX publication_query_account_updated ON publication_query(account_id, updated_at DESC, publication_id DESC);
        CREATE INDEX publication_query_platform_updated ON publication_query(platform_id, updated_at DESC, publication_id DESC);
        PRAGMA user_version=4;
      `);
      const rows = sql
        .prepare("SELECT id, record FROM publications")
        .all() as Record<string, unknown>[];
      const insert = sql.prepare(
        "INSERT INTO publication_query VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of rows) {
        const record = publicationSnapshot(JSON.parse(String(row.record)));
        insert.run(
          record.publication.id,
          record.publication.platformId,
          record.publication.accountId,
          record.publication.state,
          displayGroupForMigration(record.publication.state),
          record.contentRevision.title ?? null,
          record.contentRevision.body,
          record.createdAt,
          record.updatedAt,
        );
      }
      sql
        .prepare("INSERT INTO schema_migrations VALUES (4, ?, ?)")
        .run(
          "Add publication task queries and attention history",
          new Date().toISOString(),
        );
    });
    version = 4;
    observer?.report("persistence.sqlite.migration_completed", { version });
  }
  if (version === 4) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v5",
      version: 5,
    });
    if (existed)
      database.backup(`${database.filename}.before-v5-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
        CREATE TABLE publication_selected_contents (
          publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
          external_content_id TEXT NOT NULL
        ) STRICT;
        CREATE TABLE publication_deleted_requests (
          request_id TEXT PRIMARY KEY,
          deleted_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version=5;
      `);
      sql
        .prepare("INSERT INTO schema_migrations VALUES (5, ?, ?)")
        .run(
          "Add selected publication content and deleted request markers",
          new Date().toISOString(),
        );
    });
    version = 5;
    observer?.report("persistence.sqlite.migration_completed", { version });
  }
  if (version === 5) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v6",
      version: 6,
    });
    if (existed)
      database.backup(`${database.filename}.before-v6-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
        CREATE TABLE account_browser_switches (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          candidate_profile_id TEXT NOT NULL UNIQUE,
          phase TEXT NOT NULL CHECK(phase IN ('preparing', 'awaiting_login', 'committed', 'cancelled')),
          record TEXT NOT NULL CHECK(json_valid(record))
        ) STRICT;
        CREATE UNIQUE INDEX account_browser_switch_pending ON account_browser_switches(account_id)
          WHERE phase IN ('preparing', 'awaiting_login');
        PRAGMA user_version=6;
      `);
      sql
        .prepare("INSERT INTO schema_migrations VALUES (6, ?, ?)")
        .run(
          "Add recoverable targeted account browser switches",
          new Date().toISOString(),
        );
    });
    version = 6;
    observer?.report("persistence.sqlite.migration_completed", { version: 6 });
  }
  if (version === 6) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v7",
      version: 7,
    });
    if (existed)
      database.backup(`${database.filename}.before-v7-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(
        `CREATE TABLE account_platform_merges (merged_account_id TEXT PRIMARY KEY, surviving_account_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record))) STRICT; PRAGMA user_version=7;`,
      );
      sql
        .prepare("INSERT INTO schema_migrations VALUES (7, ?, ?)")
        .run("Add account merge decision records", new Date().toISOString());
    });
    version = 7;
    observer?.report("persistence.sqlite.migration_completed", { version: 7 });
  }
  if (version === 7) {
    observer?.report("persistence.sqlite.migration_started", {
      stage: "schema_v8",
      version: 8,
    });
    if (existed)
      database.backup(`${database.filename}.before-v8-${randomUUID()}.sqlite`);
    database.transaction(() => {
      sql.exec(`
        CREATE TABLE runtime_access_settings (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
        CREATE TABLE runtime_disabled_accounts (account_id TEXT PRIMARY KEY REFERENCES platform_accounts(id) ON DELETE CASCADE) STRICT;
        CREATE TABLE scheduled_tasks (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK(type IN ('account_profile_sync','platform_content_sync','publication')),
          account_id TEXT NOT NULL,
          platform_id TEXT NOT NULL,
          request_id TEXT UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('queued','running','awaiting_confirmation','retry_wait','finalizing','completed','partial','failed','cancelled','uncertain')),
          record TEXT NOT NULL CHECK(json_valid(record))
        ) STRICT;
        CREATE UNIQUE INDEX scheduled_task_account_lease ON scheduled_tasks(account_id)
          WHERE state IN ('running','awaiting_confirmation','finalizing');
        CREATE UNIQUE INDEX scheduled_sync_pending ON scheduled_tasks(account_id,type)
          WHERE type != 'publication' AND state NOT IN ('completed','partial','failed','cancelled','uncertain');
        CREATE INDEX scheduled_task_queue ON scheduled_tasks(state,sequence);
        CREATE INDEX scheduled_task_account ON scheduled_tasks(account_id,sequence);
        CREATE INDEX scheduled_task_platform ON scheduled_tasks(platform_id,sequence);
        CREATE TABLE task_attempts (
          task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
          attempt INTEGER NOT NULL CHECK(attempt > 0),
          record TEXT NOT NULL CHECK(json_valid(record)),
          PRIMARY KEY(task_id,attempt)
        ) STRICT;
        CREATE TABLE sync_rules (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('account_profile_sync','platform_content_sync')),
          record TEXT NOT NULL CHECK(json_valid(record)),
          UNIQUE(account_id,type)
        ) STRICT;
        CREATE TABLE task_scheduler_settings (
          id INTEGER PRIMARY KEY CHECK(id=1),
          max_parallel INTEGER NOT NULL CHECK(max_parallel > 0),
          retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days > 0)
        ) STRICT;
        INSERT INTO task_scheduler_settings VALUES (1,3,30);
        CREATE TABLE task_attention_seen (
          task_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
          version TEXT NOT NULL
        ) STRICT;
        CREATE TABLE task_request_markers (
          request_id TEXT PRIMARY KEY,
          record TEXT NOT NULL CHECK(json_valid(record))
        ) STRICT;
        CREATE INDEX scheduled_task_history ON scheduled_tasks(sequence, json_extract(record,'$.endedAt'))
          WHERE state IN ('completed','partial','failed','cancelled','uncertain');
        CREATE TABLE task_cooldowns (scope TEXT PRIMARY KEY, until_ms INTEGER NOT NULL) STRICT;
        PRAGMA user_version=8;
      `);
      sql
        .prepare("INSERT INTO schema_migrations VALUES (8, ?, ?)")
        .run(
          "Add local runtime access settings and unified task scheduling",
          new Date().toISOString(),
        );
    });
    observer?.report("persistence.sqlite.migration_completed", { version: 8 });
  }
}

function displayGroupForMigration(state: string): string {
  if (state === "awaiting_confirmation") return "action_required";
  if (["uncertain", "failed"].includes(state)) return "attention_required";
  if (state === "published") return "completed";
  if (["rejected", "cancelled"].includes(state)) return "closed";
  return "in_progress";
}
