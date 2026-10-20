import { buildXhsCommonNote } from "./note-body.js";
import { XhsPreparationError, checkCancellation } from "./errors.js";
import { inspectImage, type XhsImageMetadata } from "./image-metadata.js";
import { parseImagePermit, type XhsUploadPermit } from "./upload-target.js";

export interface XhsLocalImage {
  readonly resourceId: string;
  readonly bytes: Uint8Array;
}
export interface XhsImageNoteInput {
  readonly title: string;
  readonly body: string;
  readonly images: readonly XhsLocalImage[];
}
export interface XhsImagePreparationPorts {
  readonly allowedUploadHosts: readonly string[];
  verifyIdentity(signal?: AbortSignal): Promise<void>;
  requestImagePermit(signal?: AbortSignal): Promise<unknown>;
  /** Token only goes to this permit's validated HTTPS target; no Cookie/signature or redirect/replay. */
  uploadImage(input: {
    permit: XhsUploadPermit;
    bytes: Uint8Array;
    metadata: XhsImageMetadata;
    signal?: AbortSignal;
    onProgress?: (uploadedBytes: number) => void;
  }): Promise<{ status: number }>;
}
export interface XhsPreparedImage extends XhsImageMetadata {
  readonly resourceId: string;
  readonly fileId: string;
  readonly size: number;
  readonly order: number;
}
export interface XhsPreparationProgress {
  readonly phase: "permit" | "upload" | "uploaded";
  readonly imageIndex: number;
  readonly imageCount: number;
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly attempt: number;
}
export interface XhsPreparedImageNote {
  readonly platformId: "xhs-sign";
  readonly contentForm: "imageText";
  readonly images: readonly XhsPreparedImage[];
  readonly serializedBody: string;
  readonly submissionStatus: "not_submitted";
}

export async function prepareImageNote(
  input: XhsImageNoteInput,
  ports: XhsImagePreparationPorts,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: XhsPreparationProgress) => void;
    maxImageBytes?: number;
    uploadAttempts?: number;
  } = {},
): Promise<XhsPreparedImageNote> {
  const { signal } = options;
  checkCancellation(signal);
  if (
    !input ||
    Object.keys(input).some((key) => !["title", "body", "images"].includes(key))
  )
    throw new XhsPreparationError("unsupported_field");
  if (
    typeof input.title !== "string" ||
    typeof input.body !== "string" ||
    input.title.length > 20 ||
    input.body.length > 1000 ||
    !Array.isArray(input.images) ||
    !input.images.length
  )
    throw new XhsPreparationError("invalid_content");
  if (input.images.length > 18)
    throw new XhsPreparationError("image_count_exceeded");
  const maxBytes = options.maxImageBytes ?? 20 * 1024 * 1024;
  const attempts = options.uploadAttempts ?? 2;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 3
  )
    throw new XhsPreparationError("invalid_content");
  // Freeze every local image before asynchronous work; a caller cannot swap the bytes after metadata inspection.
  const sources = input.images.map((image) => {
    if (
      !image ||
      typeof image.resourceId !== "string" ||
      !image.resourceId ||
      !(image.bytes instanceof Uint8Array)
    )
      throw new XhsPreparationError("invalid_image");
    if (image.bytes.byteLength > maxBytes)
      throw new XhsPreparationError("image_too_large");
    const bytes = new Uint8Array(image.bytes);
    return {
      resourceId: image.resourceId,
      bytes,
      metadata: inspectImage(bytes),
    };
  });
  const title = input.title;
  const body = input.body;
  const images: XhsPreparedImage[] = [];
  for (const [imageIndex, source] of sources.entries()) {
    checkCancellation(signal);
    try {
      await ports.verifyIdentity(signal);
    } catch {
      checkCancellation(signal);
      throw new XhsPreparationError("identity_not_verified");
    }
    checkCancellation(signal);
    const progress = (
      phase: XhsPreparationProgress["phase"],
      attempt: number,
      uploadedBytes = 0,
    ) => {
      options.onProgress?.({
        phase,
        imageIndex,
        imageCount: sources.length,
        uploadedBytes: Math.max(
          0,
          Math.min(source.bytes.byteLength, uploadedBytes),
        ),
        totalBytes: source.bytes.byteLength,
        attempt,
      });
    };
    progress("permit", 0);
    let response: unknown;
    try {
      response = await ports.requestImagePermit(signal);
    } catch {
      checkCancellation(signal);
      throw new XhsPreparationError("permit_rejected");
    }
    checkCancellation(signal);
    const permit = parseImagePermit(response, ports.allowedUploadHosts);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      checkCancellation(signal);
      progress("upload", attempt);
      let status: number;
      try {
        const result = await ports.uploadImage({
          permit,
          bytes: source.bytes,
          metadata: source.metadata,
          ...(signal ? { signal } : {}),
          onProgress: (n) => progress("upload", attempt, n),
        });
        status = result.status;
      } catch (error) {
        checkCancellation(signal);
        if (
          error instanceof XhsPreparationError &&
          error.code !== "upload_failed"
        )
          throw error;
        if (attempt < attempts) continue;
        throw new XhsPreparationError("upload_failed");
      }
      checkCancellation(signal);
      if (status >= 300 && status < 400)
        throw new XhsPreparationError("upload_redirect_rejected");
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        if (status >= 500 && attempt < attempts) continue;
        throw new XhsPreparationError("upload_failed");
      }
      progress("uploaded", attempt, source.bytes.byteLength);
      images.push(
        Object.freeze({
          ...source.metadata,
          resourceId: source.resourceId,
          fileId: permit.fileId,
          size: source.bytes.byteLength,
          order: imageIndex,
        }),
      );
      break;
    }
  }
  checkCancellation(signal);
  // Reference-derived minimum request candidate, not yet verified by a real note submission.
  const candidate = {
    common: buildXhsCommonNote(title, body, "normal"),
    image_info: {
      images: images.map((image) => ({
        file_id: image.fileId,
        width: image.width,
        height: image.height,
        metadata: { source: -1 },
        stickers: { version: 2, floating: [] },
        extra_info_json: JSON.stringify({ mimeType: image.mediaType }),
      })),
    },
    video_info: null,
  };
  return Object.freeze({
    platformId: "xhs-sign",
    contentForm: "imageText",
    images: Object.freeze(images),
    serializedBody: JSON.stringify(candidate),
    submissionStatus: "not_submitted",
  });
}
