import type {
  PublicationDisplayGroup,
  PublicationQuery,
  PublicationQueryResult,
  PublicationSnapshot,
  PublicationRepository,
  PublicationQueryPort,
} from "@nedia-matrix/publishing";
import { publicationDisplayGroup } from "@nedia-matrix/publishing";
import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";
import { publicationSnapshot } from "../../persistence/metadata-validation.js";

const effectiveGroupSql =
  "CASE WHEN q.state='uncertain' AND r.resolution='confirmed_published' AND r.manual_platform_content_id IS NOT NULL THEN 'completed' ELSE q.display_group END";

export class SqlitePublicationRepository
  implements PublicationRepository, PublicationQueryPort
{
  constructor(private readonly database: DesktopMetadataDatabase) {}

  private decode(row: Record<string, unknown>): PublicationSnapshot {
    const record = publicationSnapshot(JSON.parse(String(row.record)));
    if (record.publication.id !== row.id || record.requestId !== row.request_id)
      throw new Error("Publication index mismatch");
    return record;
  }
  list(): PublicationSnapshot[] {
    return this.database.connection
      .prepare("SELECT * FROM publications")
      .all()
      .map((row) => this.decode(row))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): PublicationSnapshot | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM publications WHERE id=?")
      .get(id);
    return row ? this.decode(row) : undefined;
  }
  findByRequestId(requestId: string): PublicationSnapshot | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM publications WHERE request_id=?")
      .get(requestId);
    return row ? this.decode(row) : undefined;
  }

  save(record: PublicationSnapshot): void {
    publicationSnapshot(record);
    this.withTransaction(() => {
      if (this.isDeletedRequestId(record.requestId))
        throw new TypeError("Deleted publication request cannot be replayed");
      this.database.connection
        .prepare(
          "INSERT INTO publications VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id, record=excluded.record",
        )
        .run(record.publication.id, record.requestId, JSON.stringify(record));
      this.database.connection
        .prepare(
          "INSERT INTO publication_query VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(publication_id) DO UPDATE SET platform_id=excluded.platform_id, account_id=excluded.account_id, state=excluded.state, display_group=excluded.display_group, title=excluded.title, body=excluded.body, created_at=excluded.created_at, updated_at=excluded.updated_at",
        )
        .run(
          record.publication.id,
          record.publication.platformId,
          record.publication.accountId,
          record.publication.state,
          publicationDisplayGroup(record.publication.state),
          record.contentRevision.title ?? null,
          record.contentRevision.body,
          record.createdAt,
          record.updatedAt,
        );
    });
  }
  remove(id: string): void {
    this.withTransaction(() => {
      const record = this.get(id);
      if (!record) throw new TypeError("Publication does not exist");
      const pending = this.database.connection
        .prepare(
          "SELECT 1 FROM publication_observation_inbox WHERE publication_id=? LIMIT 1",
        )
        .get(id);
      if (pending)
        throw new TypeError("Publication still has pending observations");
      this.database.connection
        .prepare(
          "INSERT INTO publication_deleted_requests VALUES (?, ?) ON CONFLICT(request_id) DO NOTHING",
        )
        .run(record.requestId, new Date().toISOString());
      this.database.connection
        .prepare("DELETE FROM publications WHERE id=?")
        .run(id);
    });
  }

  isDeletedRequestId(requestId: string): boolean {
    return Boolean(
      this.database.connection
        .prepare(
          "SELECT 1 FROM publication_deleted_requests WHERE request_id=?",
        )
        .get(requestId),
    );
  }

  selectedContentId(publicationId: string): string | null {
    const row = this.database.connection
      .prepare(
        "SELECT external_content_id FROM publication_selected_contents WHERE publication_id=?",
      )
      .get(publicationId) as { external_content_id: string } | undefined;
    return row?.external_content_id ?? null;
  }

  selectContent(publicationId: string, externalContentId: string): void {
    this.database.connection
      .prepare(
        "INSERT INTO publication_selected_contents VALUES (?, ?) ON CONFLICT(publication_id) DO UPDATE SET external_content_id=excluded.external_content_id",
      )
      .run(publicationId, externalContentId);
  }

  query(input: PublicationQuery): {
    records: PublicationSnapshot[];
    nextCursor: string | null;
    counts: PublicationQueryResult["counts"];
    tabCounts: PublicationQueryResult["tabCounts"];
    total: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.view === "pending") {
      clauses.push(
        "(q.display_group IN ('action_required', 'in_progress') OR (q.display_group='attention_required' AND r.publication_id IS NULL))",
      );
    }
    if (input.platformId) {
      clauses.push("q.platform_id=?");
      params.push(input.platformId);
    }
    if (input.accountId) {
      clauses.push("q.account_id=?");
      params.push(input.accountId);
    }
    if (input.group) {
      clauses.push(`${effectiveGroupSql}=?`);
      params.push(input.group);
    }
    if (input.state) {
      clauses.push("q.state=?");
      params.push(input.state);
    }
    if (input.keyword?.trim()) {
      const keyword = `%${escapeLike(input.keyword.trim())}%`;
      clauses.push("(q.title LIKE ? ESCAPE '\\' OR q.body LIKE ? ESCAPE '\\')");
      params.push(keyword, keyword);
    }
    if (input.createdFrom) {
      clauses.push("q.created_at>=?");
      params.push(input.createdFrom);
    }
    if (input.createdTo) {
      clauses.push("q.created_at<=?");
      params.push(input.createdTo);
    }
    const total = Number(
      this.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM publication_query q LEFT JOIN publication_attention_resolution r ON r.publication_id=q.publication_id WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"}`,
        )
        .get(...params)?.count ?? 0,
    );
    const tabCounts = this.taskCounts(input);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor) {
      if (input.view === "pending") {
        if (!cursor.group) throw new TypeError("Invalid publication cursor");
        clauses.push(
          "(CASE q.display_group WHEN 'action_required' THEN 0 WHEN 'attention_required' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END > ? OR (q.display_group=? AND (q.updated_at < ? OR (q.updated_at = ? AND q.publication_id < ?))))",
        );
        params.push(
          pendingGroupRank(cursor.group),
          cursor.group,
          cursor.updatedAt,
          cursor.updatedAt,
          cursor.id,
        );
      } else {
        clauses.push(
          "(q.updated_at < ? OR (q.updated_at = ? AND q.publication_id < ?))",
        );
        params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      }
    }
    const rows = this.database.connection
      .prepare(
        `SELECT q.publication_id, q.updated_at, q.display_group FROM publication_query q LEFT JOIN publication_attention_resolution r ON r.publication_id=q.publication_id WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"} ORDER BY ${input.view === "pending" ? "CASE q.display_group WHEN 'action_required' THEN 0 WHEN 'attention_required' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, " : ""}q.updated_at DESC, q.publication_id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Record<string, unknown>[];
    const hasNext = rows.length > limit;
    const selected = hasNext ? rows.slice(0, limit) : rows;
    const records = selected.map((row) =>
      this.get(String(row.publication_id))!,
    );
    const last = selected.at(-1) as Record<string, unknown> | undefined;
    return {
      records,
      nextCursor:
        hasNext && last
          ? encodeCursor({
              updatedAt: String(last.updated_at),
              id: String(last.publication_id),
              ...(input.view === "pending"
                ? {
                    group: String(
                      last.display_group,
                    ) as PublicationDisplayGroup,
                  }
                : {}),
            })
          : null,
      counts: this.taskCounts(),
      tabCounts,
      total,
    };
  }

  private taskCounts(
    input?: PublicationQuery,
  ): PublicationQueryResult["counts"] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (input?.platformId) {
      clauses.push("q.platform_id=?");
      params.push(input.platformId);
    }
    if (input?.accountId) {
      clauses.push("q.account_id=?");
      params.push(input.accountId);
    }
    if (input?.keyword?.trim()) {
      const keyword = `%${escapeLike(input.keyword.trim())}%`;
      clauses.push("(q.title LIKE ? ESCAPE '\\' OR q.body LIKE ? ESCAPE '\\')");
      params.push(keyword, keyword);
    }
    const rows = this.database.connection
      .prepare(
        `SELECT ${effectiveGroupSql} AS display_group, r.resolution, COUNT(*) AS count FROM publication_query q LEFT JOIN publication_attention_resolution r ON r.publication_id=q.publication_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} GROUP BY ${effectiveGroupSql}, r.resolution`,
      )
      .all(...params) as Record<string, unknown>[];
    const counts = {
      actionRequired: 0,
      openAttentionRequired: 0,
      inProgress: 0,
      completed: 0,
      completedAutomatic: 0,
      completedManual: 0,
      attentionRequired: 0,
      closed: 0,
      all: 0,
      pending: 0,
    };
    for (const row of rows) {
      const count = Number(row.count);
      counts.all += count;
      if (row.display_group === "action_required")
        counts.actionRequired += count;
      if (row.display_group === "attention_required") {
        counts.attentionRequired += count;
        if (row.resolution === null) counts.openAttentionRequired += count;
      }
      if (row.display_group === "in_progress") counts.inProgress += count;
      if (row.display_group === "completed") {
        counts.completed += count;
        if (row.resolution === "confirmed_published")
          counts.completedManual += count;
        else counts.completedAutomatic += count;
      }
      if (row.display_group === "closed") counts.closed += count;
    }
    counts.pending =
      counts.actionRequired + counts.openAttentionRequired + counts.inProgress;
    return counts;
  }

  private withTransaction(operation: () => void): void {
    if (this.database.connection.isTransaction) {
      operation();
      return;
    }
    this.database.transaction(operation);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function encodeCursor(cursor: {
  updatedAt: string;
  id: string;
  group?: PublicationDisplayGroup;
}): string {
  return `v1.${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeCursor(value: string): {
  updatedAt: string;
  id: string;
  group?: PublicationDisplayGroup;
} | null {
  try {
    const [version, encoded] = value.split(".", 2);
    if (version !== "v1" || !encoded) throw new TypeError("Invalid version");
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (
      parsed &&
      typeof parsed.updatedAt === "string" &&
      typeof parsed.id === "string" &&
      parsed.updatedAt &&
      parsed.id
    ) {
      if (
        parsed.group !== undefined &&
        ![
          "action_required",
          "attention_required",
          "in_progress",
          "closed",
          "completed",
        ].includes(parsed.group)
      )
        throw new TypeError("Invalid cursor group");
      return parsed;
    }
  } catch {
    // The application layer reports malformed cursors as invalid input.
  }
  throw new TypeError("Invalid publication cursor");
}

function pendingGroupRank(group: PublicationDisplayGroup): number {
  switch (group) {
    case "action_required":
      return 0;
    case "attention_required":
      return 1;
    case "in_progress":
      return 2;
    case "completed":
    case "closed":
      return 3;
  }
}
