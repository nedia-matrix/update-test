import {
  assertPlatformContentSnapshot,
  type PlatformContentRepository,
  type PlatformContentSnapshot,
  type PlatformContentSyncRun,
} from "@nedia-matrix/platform-content";
import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";

function parseContent(value: unknown): PlatformContentSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid platform content snapshot");
  }
  return assertPlatformContentSnapshot({
    ...value,
    contentUrl:
      "contentUrl" in value && value.contentUrl !== undefined
        ? value.contentUrl
        : null,
  } as PlatformContentSnapshot);
}

function parseRun(value: unknown): PlatformContentSyncRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid platform content sync run");
  }
  const run = value as Partial<PlatformContentSyncRun>;
  if (
    typeof run.id !== "string" ||
    !run.id.trim() ||
    typeof run.accountId !== "string" ||
    !run.accountId.trim() ||
    !(["completed", "partial", "failed"] as const).some(
      (status) => status === run.status,
    ) ||
    typeof run.startedAt !== "string" ||
    Number.isNaN(Date.parse(run.startedAt)) ||
    typeof run.completedAt !== "string" ||
    Number.isNaN(Date.parse(run.completedAt)) ||
    !Number.isSafeInteger(run.pagesRead) ||
    run.pagesRead! < 0 ||
    !Number.isSafeInteger(run.itemsRead) ||
    run.itemsRead! < 0 ||
    !(
      run.remoteTotal === null ||
      (Number.isSafeInteger(run.remoteTotal) && run.remoteTotal! >= 0)
    ) ||
    !Array.isArray(run.diagnostics) ||
    !run.diagnostics.every((message) => typeof message === "string") ||
    Date.parse(run.startedAt) > Date.parse(run.completedAt)
  ) {
    throw new TypeError("Invalid platform content sync run");
  }
  return run as PlatformContentSyncRun;
}

export class SqlitePlatformContentRepository implements PlatformContentRepository {
  constructor(private readonly database: DesktopMetadataDatabase) {}

  listByAccount(accountId: string): PlatformContentSnapshot[] {
    return this.database.connection
      .prepare(
        "SELECT record FROM platform_contents WHERE account_id=? ORDER BY json_extract(record, '$.publishedAt') DESC, id DESC",
      )
      .all(accountId)
      .map((row) => parseContent(JSON.parse(String(row.record))));
  }

  findMany(
    accountId: string,
    externalContentIds: readonly string[],
  ): PlatformContentSnapshot[] {
    if (externalContentIds.length === 0) return [];
    const placeholders = externalContentIds.map(() => "?").join(", ");
    return this.database.connection
      .prepare(
        `SELECT record FROM platform_contents
         WHERE account_id=? AND external_content_id IN (${placeholders})`,
      )
      .all(accountId, ...externalContentIds)
      .map((row) => parseContent(JSON.parse(String(row.record))));
  }

  find(
    accountId: string,
    externalContentId: string,
  ): PlatformContentSnapshot | undefined {
    const row = this.database.connection
      .prepare(
        "SELECT record FROM platform_contents WHERE account_id=? AND external_content_id=?",
      )
      .get(accountId, externalContentId);
    return row ? parseContent(JSON.parse(String(row.record))) : undefined;
  }

  saveAll(
    contents: readonly PlatformContentSnapshot[],
    run: PlatformContentSyncRun,
    completeExternalContentIds?: readonly string[],
  ): void {
    const operation = () => {
      const parsedRun = parseRun(run);
      if (completeExternalContentIds !== undefined) {
        const inventory = new Set(completeExternalContentIds);
        if (
          parsedRun.status !== "completed" ||
          parsedRun.pagesRead < 1 ||
          completeExternalContentIds.some(
            (id) => typeof id !== "string" || !id.trim(),
          ) ||
          inventory.size !== parsedRun.itemsRead ||
          (parsedRun.remoteTotal !== null &&
            parsedRun.itemsRead < parsedRun.remoteTotal) ||
          contents.some((content) => !inventory.has(content.externalContentId))
        ) {
          throw new Error(
            "Cannot reconcile an incomplete platform content inventory",
          );
        }
      }
      const statement = this.database.connection.prepare(`
        INSERT INTO platform_contents VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          account_id=excluded.account_id,
          external_content_id=excluded.external_content_id,
          record=excluded.record
      `);
      for (const content of contents) {
        const parsed = parseContent(content);
        if (parsed.accountId !== parsedRun.accountId) {
          throw new Error("Content sync run account mismatch");
        }
        statement.run(
          parsed.id,
          parsed.accountId,
          parsed.externalContentId,
          JSON.stringify(parsed),
        );
      }
      if (completeExternalContentIds !== undefined) {
        this.database.connection
          .prepare(
            `
          DELETE FROM platform_contents
          WHERE account_id=? AND external_content_id NOT IN (SELECT value FROM json_each(?))
        `,
          )
          .run(parsedRun.accountId, JSON.stringify(completeExternalContentIds));
      }
      this.writeRun(parsedRun);
    };
    if (this.database.connection.isTransaction) operation();
    else this.database.transaction(operation);
  }

  saveRun(run: PlatformContentSyncRun): void {
    const operation = () => this.writeRun(parseRun(run));
    if (this.database.connection.isTransaction) operation();
    else this.database.transaction(operation);
  }

  latestRun(accountId: string): PlatformContentSyncRun | undefined {
    const row = this.database.connection
      .prepare(
        "SELECT record FROM platform_content_sync_runs WHERE account_id=?",
      )
      .get(accountId);
    return row ? parseRun(JSON.parse(String(row.record))) : undefined;
  }

  private writeRun(run: PlatformContentSyncRun): void {
    this.database.connection
      .prepare(
        `INSERT INTO platform_content_sync_runs VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET record=excluded.record`,
      )
      .run(run.accountId, JSON.stringify(run));
  }
}
