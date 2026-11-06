import { isDeepStrictEqual } from "node:util";
import {
  Publication,
  type PublicationSnapshot,
} from "@nedia-matrix/publishing";
import { parseStoredPublications } from "../publishing/infrastructure/publication-state-codec.js";
import type { PublishObservationEvent } from "@nedia-matrix/publishing";
import { publishResultKinds } from "@nedia-matrix/platform-sdk";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid metadata object");
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid metadata collection");
  return value;
}

export function publicationSnapshot(value: unknown): PublicationSnapshot {
  const parsed = parseStoredPublications([value])[0];
  if (
    !parsed ||
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(parsed)),
      JSON.parse(JSON.stringify(value)),
    )
  )
    throw new Error("Invalid publication metadata");
  try {
    return Publication.rehydrate(parsed).toSnapshot();
  } catch (error) {
    throw new Error(
      "Invalid publication metadata",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export function observationEvent(value: unknown): PublishObservationEvent {
  const event = object(value);
  for (const key of [
    "eventId",
    "observationId",
    "publicationId",
    "accountId",
    "platformId",
  ]) {
    if (typeof event[key] !== "string" || !event[key])
      throw new Error("Invalid observation identifier");
  }
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1)
    throw new Error("Invalid observation sequence");
  const result = object(event.result);
  if (!publishResultKinds.includes(result.kind as never))
    throw new Error("Invalid observation result");
  if (result.kind === "published") {
    for (const key of ["contentId", "contentUrl"])
      if (result[key] !== null && typeof result[key] !== "string")
        throw new Error("Invalid observation content");
  } else if (typeof result.message !== "string")
    throw new Error("Invalid observation message");
  if (
    result.kind === "submission_attempted" &&
    result.source !== "application_commit" &&
    result.source !== "page_request"
  )
    throw new Error("Invalid observation source");
  return value as PublishObservationEvent;
}
