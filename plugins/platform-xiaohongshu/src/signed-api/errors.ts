export type XhsPreparationErrorCode =
  | "invalid_content"
  | "unsupported_field"
  | "image_count_exceeded"
  | "image_too_large"
  | "invalid_image"
  | "invalid_video"
  | "video_too_large"
  | "video_changed"
  | "multipart_invalid"
  | "permit_rejected"
  | "permit_invalid"
  | "upload_target_rejected"
  | "upload_failed"
  | "upload_redirect_rejected"
  | "cancelled"
  | "identity_not_verified";

export class XhsPreparationError extends Error {
  constructor(readonly code: XhsPreparationErrorCode) {
    super(code);
    this.name = "XhsPreparationError";
  }
}

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new XhsPreparationError("cancelled");
}
