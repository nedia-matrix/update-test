import type { PreparePublishDraftResult } from "./index.js";
import {
  MediaSelectionUnavailableError,
  type PublicationStatePort,
  type PublishFailureClassifier,
} from "./ports.js";

type FailurePersistence = Pick<
  PublicationStatePort,
  "get" | "markPreparationFailed" | "markSubmissionUncertain"
>;

export function handlePublishFailure(
  error: unknown,
  publicationId: string | undefined,
  publishing: FailurePersistence,
  classifier: PublishFailureClassifier,
): PreparePublishDraftResult {
  const message = error instanceof Error ? error.message : "Prepare failed";
  const current = publicationId ? publishing.get(publicationId) : undefined;
  try {
    if (
      (current?.publication.state === "submitting" &&
        current.submissionEvidence !== "none") ||
      current?.publication.state === "verifying"
    ) {
      publishing.markSubmissionUncertain(current.publication.id, message);
    } else if (
      current &&
      current.publication.state !== "uncertain" &&
      current.publication.state !== "failed"
    ) {
      publishing.markPreparationFailed(current.publication.id, message);
    }
  } catch {
    // The original workflow failure remains the actionable result.
  }
  if (current?.publication.state === "published") {
    return {
      status: "already_started",
      publicationId: current.publication.id,
      state: "published",
    };
  }
  const classified = classifier.classify(error);
  if (
    (current?.publication.state === "submitting" &&
      current.submissionEvidence !== "none") ||
    current?.publication.state === "verifying" ||
    current?.publication.state === "uncertain"
  ) {
    return {
      status: "uncertain",
      code: classified?.code ?? "SUBMISSION_RESULT_UNCERTAIN",
      message,
      evidenceId: classified?.evidenceId ?? null,
      publicationId: current.publication.id,
    };
  }
  if (classified) {
    return {
      status: "failed",
      ...(current ? { publicationId: current.publication.id } : {}),
      code: classified.code,
      message,
      evidenceId: classified.evidenceId,
    };
  }
  if (error instanceof MediaSelectionUnavailableError) {
    return {
      status: "failed",
      ...(current ? { publicationId: current.publication.id } : {}),
      code: "MEDIA_SELECTION_UNAVAILABLE",
      message: "媒体选择已失效，请重新选择文件",
      evidenceId: null,
    };
  }
  return {
    status: "failed",
    ...(current ? { publicationId: current.publication.id } : {}),
    code: "UNEXPECTED_ERROR",
    message,
    evidenceId: null,
  };
}
