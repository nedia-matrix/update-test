import type {
  SubmissionMode,
  SupportedPublishContentForm as PublishContentForm,
} from "../domain/index.js";

import type { PreparePublishDraftRequest } from "./index.js";
import type { RemotePublicationAsset } from "./ports.js";

export interface PrepareRemoteDraftRequest {
  accountId: string;
  requestId: string;
  contentForm: "video" | "imageText";
  title: string;
  body: string;
  tags?: readonly string[];
  assets: readonly RemotePublicationAsset[];
}

export function isContentForm(value: unknown): value is PublishContentForm {
  return value === "video" || value === "imageText";
}

export function validatePublishDraftRequest(
  request: PreparePublishDraftRequest,
): void {
  if (
    !isContentForm(request.contentForm) ||
    typeof request.mediaSelectionId !== "string" ||
    typeof request.title !== "string" ||
    typeof request.body !== "string" ||
    !isTags(request.tags) ||
    (request.requestId !== undefined &&
      (typeof request.requestId !== "string" ||
        request.requestId.trim().length === 0 ||
        request.requestId.length > 128)) ||
    (request.sourcePublicationId !== undefined &&
      (typeof request.sourcePublicationId !== "string" ||
        request.sourcePublicationId.trim().length === 0 ||
        request.sourcePublicationId.length > 128)) ||
    !isSubmissionMode(request.submissionMode) ||
    request.title.length > 200 ||
    request.body.length > 20_000
  ) {
    throw new TypeError("Invalid publish draft request");
  }
}

export function validateRemoteDraftRequest(
  request: PrepareRemoteDraftRequest,
): string {
  if (
    typeof request.requestId !== "string" ||
    !/^[A-Za-z0-9._~-]{1,128}$/.test(request.requestId.trim()) ||
    !isContentForm(request.contentForm) ||
    typeof request.title !== "string" ||
    typeof request.body !== "string" ||
    request.title.length > 200 ||
    request.body.length > 20_000 ||
    !isTags(request.tags) ||
    !Array.isArray(request.assets)
  ) {
    throw new TypeError("Invalid remote publish draft request");
  }
  return request.requestId.trim();
}

export function validateRemoteAssetsForForm(
  contentForm: "video" | "imageText",
  assets: readonly RemotePublicationAsset[],
): RemotePublicationAsset[] {
  const ordered = [...assets].sort((left, right) => left.order - right.order);
  if (ordered.some((asset, index) => asset.order !== index)) {
    throw new TypeError("Remote asset order must be contiguous and unique");
  }
  if (contentForm === "video") {
    if (
      ordered.length !== 1 ||
      ordered[0]?.role !== "video" ||
      ordered[0].mediaType !== "video/mp4"
    ) {
      throw new TypeError("Video publication requires exactly one MP4 video");
    }
  } else if (
    ordered.some(
      (asset) =>
        asset.role !== "image" || !asset.mediaType.startsWith("image/"),
    )
  ) {
    throw new TypeError("Image-text publication only accepts image assets");
  }
  return ordered;
}

function isSubmissionMode(value: unknown): value is SubmissionMode | undefined {
  return (
    value === undefined ||
    value === "automatic" ||
    value === "manual_confirmation"
  );
}

function isTags(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 20 &&
      value.every((tag) => typeof tag === "string" && tag.length <= 50))
  );
}
