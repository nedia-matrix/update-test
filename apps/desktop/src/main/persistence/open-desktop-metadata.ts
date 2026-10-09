import { join } from "node:path";
import { DesktopMetadataDatabase } from "./desktop-metadata-database.js";
import { importLegacyStores } from "./legacy-store-import.js";
import { SqliteAccountRepository } from "../accounts/infrastructure/sqlite-account-repository.js";
import { SqlitePublicationRepository } from "../publishing/infrastructure/sqlite-publication-repository.js";
import { SqlitePublicationAttentionRepository } from "../publishing/infrastructure/sqlite-publication-attention-repository.js";
import { SqlitePublicationObservationInbox } from "../publishing/infrastructure/sqlite-publication-observation-inbox.js";
import { SqlitePlatformContentRepository } from "../platform-content/infrastructure/sqlite-platform-content-repository.js";
import type { MetadataMigrationObserver } from "./schema-migrations.js";

export function openDesktopMetadata(
  directory: string,
  observer?: MetadataMigrationObserver,
) {
  const database = new DesktopMetadataDatabase(
    join(directory, "matrix-metadata.sqlite"),
    observer,
  );
  try {
    observer?.report("persistence.legacy_import.started");
    const importReport = importLegacyStores(database, directory);
    observer?.report("persistence.legacy_import.completed", {
      status: importReport ? "imported" : "not_required",
    });
    const accounts = new SqliteAccountRepository(database);
    const publications = new SqlitePublicationRepository(database);
    const publicationAttention = new SqlitePublicationAttentionRepository(
      database,
    );
    const inbox = new SqlitePublicationObservationInbox(database);
    const platformContents = new SqlitePlatformContentRepository(database);
    return {
      database,
      accounts,
      publications,
      publicationAttention,
      inbox,
      platformContents,
      importReport,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
