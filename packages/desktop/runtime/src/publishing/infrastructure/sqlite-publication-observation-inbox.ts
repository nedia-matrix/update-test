import { isDeepStrictEqual } from "node:util";
import type { DesktopMetadataDatabase } from "../../persistence/desktop-metadata-database.js";
import { observationEvent } from "../../persistence/metadata-validation.js";
import type { PublishObservationEvent } from "@nedia-matrix/publishing";
import type { PublicationObservationInbox } from "../observations/publication-observation-inbox.js";

export class SqlitePublicationObservationInbox implements PublicationObservationInbox {
  constructor(private readonly database: DesktopMetadataDatabase) {}
  list(): PublishObservationEvent[] {
    return this.database.connection
      .prepare(
        "SELECT * FROM publication_observation_inbox ORDER BY publication_id, sequence, event_id",
      )
      .all()
      .map((row) => {
        const event = observationEvent(JSON.parse(String(row.record)));
        if (
          event.eventId !== row.event_id ||
          event.publicationId !== row.publication_id ||
          event.sequence !== row.sequence
        )
          throw new Error("Observation index mismatch");
        return event;
      });
  }
  append(event: PublishObservationEvent): void {
    observationEvent(event);
    const prior = this.database.connection
      .prepare(
        "SELECT record FROM publication_observation_inbox WHERE event_id=?",
      )
      .get(event.eventId);
    if (prior) {
      if (!isDeepStrictEqual(JSON.parse(String(prior.record)), event))
        throw new Error("Conflicting observation event ID");
      return;
    }
    this.database.connection
      .prepare("INSERT INTO publication_observation_inbox VALUES (?, ?, ?, ?)")
      .run(
        event.eventId,
        event.publicationId,
        event.sequence,
        JSON.stringify(event),
      );
  }
  remove(id: string): void {
    this.database.connection
      .prepare("DELETE FROM publication_observation_inbox WHERE event_id=?")
      .run(id);
  }
}
