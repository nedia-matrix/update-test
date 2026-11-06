import type {
  PublicationAttentionRecord,
  PublicationAttentionEvent,
  PublicationAttentionRepository,
} from "@nedia-matrix/publishing";

import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";
import { publicationAttentionResolutions } from "@nedia-matrix/publishing";

export class SqlitePublicationAttentionRepository implements PublicationAttentionRepository {
  constructor(private readonly database: DesktopMetadataDatabase) {}

  get(publicationId: string): PublicationAttentionRecord | undefined {
    const row = this.database.connection
      .prepare(
        "SELECT publication_id, resolution, resolved_at, manual_platform_content_id FROM publication_attention_resolution WHERE publication_id=?",
      )
      .get(publicationId) as Record<string, unknown> | undefined;
    return row ? decode(row) : undefined;
  }

  set(record: PublicationAttentionRecord): void {
    if (!publicationAttentionResolutions.includes(record.resolution))
      throw new TypeError("Invalid publication attention resolution");
    if (!record.publicationId || !record.resolvedAt)
      throw new TypeError("Invalid publication attention record");
    if (record.resolution === "confirmed_published") {
      if (!record.manualPlatformContentId?.trim())
        throw new TypeError("A platform work ID is required");
    } else if (record.manualPlatformContentId) {
      throw new TypeError(
        "A platform work ID is only valid for confirmed publication",
      );
    }
    this.database.transaction(() => {
      this.database.connection
        .prepare(
          "INSERT INTO publication_attention_resolution(publication_id, resolution, resolved_at, manual_platform_content_id) VALUES (?, ?, ?, ?) ON CONFLICT(publication_id) DO UPDATE SET resolution=excluded.resolution, resolved_at=excluded.resolved_at, manual_platform_content_id=excluded.manual_platform_content_id",
        )
        .run(
          record.publicationId,
          record.resolution,
          record.resolvedAt,
          record.manualPlatformContentId ?? null,
        );
      this.database.connection
        .prepare(
          "INSERT INTO publication_attention_history(publication_id, resolution, resolved_at, manual_platform_content_id, reopened) VALUES (?, ?, ?, ?, 0)",
        )
        .run(
          record.publicationId,
          record.resolution,
          record.resolvedAt,
          record.manualPlatformContentId ?? null,
        );
    });
  }

  remove(publicationId: string): void {
    this.database.transaction(() => {
      const current = this.get(publicationId);
      if (!current) return;
      this.database.connection
        .prepare(
          "DELETE FROM publication_attention_resolution WHERE publication_id=?",
        )
        .run(publicationId);
      this.database.connection
        .prepare(
          "INSERT INTO publication_attention_history(publication_id, resolution, resolved_at, manual_platform_content_id, reopened) VALUES (?, ?, ?, ?, 1)",
        )
        .run(
          publicationId,
          current.resolution,
          new Date().toISOString(),
          current.manualPlatformContentId ?? null,
        );
    });
  }

  history(publicationId: string): readonly PublicationAttentionEvent[] {
    return (
      this.database.connection
        .prepare(
          "SELECT publication_id, resolution, resolved_at, manual_platform_content_id, reopened FROM publication_attention_history WHERE publication_id=? ORDER BY id",
        )
        .all(publicationId) as Record<string, unknown>[]
    ).map((row) => ({ ...decode(row), reopened: row.reopened === 1 }));
  }
}

function decode(row: Record<string, unknown>): PublicationAttentionRecord {
  if (
    typeof row.publication_id !== "string" ||
    typeof row.resolution !== "string" ||
    typeof row.resolved_at !== "string" ||
    !publicationAttentionResolutions.includes(
      row.resolution as (typeof publicationAttentionResolutions)[number],
    )
  ) {
    throw new Error("Invalid publication attention metadata");
  }
  return {
    publicationId: row.publication_id,
    resolution: row.resolution as PublicationAttentionRecord["resolution"],
    resolvedAt: row.resolved_at,
    manualPlatformContentId:
      typeof row.manual_platform_content_id === "string"
        ? row.manual_platform_content_id
        : null,
  };
}
