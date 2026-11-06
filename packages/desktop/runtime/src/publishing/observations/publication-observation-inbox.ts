import type { PublishObservationEvent } from "@nedia-matrix/publishing";

export interface PublicationObservationInbox {
  list(): PublishObservationEvent[];
  append(event: PublishObservationEvent): void;
  remove(eventId: string): void;
}
