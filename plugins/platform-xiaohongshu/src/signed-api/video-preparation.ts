import type { PluginPublishSession } from "@nedia-matrix/platform-sdk";
import { checkCancellation, XhsPreparationError } from "./errors.js";
import { inspectImage } from "./image-metadata.js";
import {
  prepareImageNote,
  type XhsImagePreparationPorts,
} from "./image-preparation.js";
import { parseImagePermit } from "./upload-target.js";
import type {
  XhsObjectRequester,
  XhsObjectResponse,
} from "./object-uploader.js";
import { buildXhsCommonNote } from "./note-body.js";
import {
  createXhsPreparedPublishSession,
  type XhsPublishSessionPorts,
} from "./publish-session.js";

export const xhsVideoChunkBytes = 5 * 1024 * 1024;
export const xhsVideoPermitEndpoint =
  "https://creator.xiaohongshu.com/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=video&file_count=1&version=1&source=web";
export interface XhsLocalVideo {
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly cover: Uint8Array;
  readPart(
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface XhsVideoPreparationPorts extends XhsImagePreparationPorts {
  openLocalVideo(
    reference: string,
    signal: AbortSignal,
  ): Promise<XhsLocalVideo>;
  requestVideoPermit(signal?: AbortSignal): Promise<unknown>;
  requestObject: XhsObjectRequester;
}
export interface XhsVideoProgress {
  phase: "upload" | "merge" | "cover";
  partNumber: number;
  totalParts: number;
  uploadedBytes: number;
  totalBytes: number;
  attempt: number;
}
function accepted(response: XhsObjectResponse): void {
  if (response.status >= 300 && response.status < 400)
    throw new XhsPreparationError("upload_redirect_rejected");
  if (
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status >= 300
  )
    throw new XhsPreparationError("upload_failed");
}
function uploadId(body: string): string {
  if (/<!DOCTYPE|<!ENTITY|<Error[\s>]/i.test(body))
    throw new XhsPreparationError("multipart_invalid");
  const matches = [
    ...body.matchAll(/<UploadId>([a-zA-Z0-9._~-]{1,2048})<\/UploadId>/g),
  ];
  if (matches.length !== 1) throw new XhsPreparationError("multipart_invalid");
  return matches[0]![1]!;
}
export function buildXhsMultipartXml(
  parts: readonly { partNumber: number; etag: string }[],
): string {
  if (
    !parts.length ||
    parts.some(
      (p, i) =>
        p.partNumber !== i + 1 ||
        !/^(?:[a-fA-F0-9-]{16,128}|"[a-fA-F0-9-]{16,128}")$/.test(p.etag),
    )
  )
    throw new XhsPreparationError("multipart_invalid");
  return `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
}
export async function prepareVideoNote(
  input: Parameters<PluginPublishSession["prepare"]>[0],
  ports: XhsVideoPreparationPorts,
  signal: AbortSignal,
  onProgress?: (event: XhsVideoProgress) => void,
): Promise<{
  readonly serializedBody: string;
  readonly submissionStatus: "not_submitted";
  readonly fileId: string;
  readonly coverFileId: string;
}> {
  checkCancellation(signal);
  if (
    typeof input.title !== "string" ||
    input.title.length > 20 ||
    typeof input.body !== "string" ||
    input.body.length > 1000 ||
    input.tags.length ||
    input.mediaReferences.length !== 1
  )
    throw new XhsPreparationError("invalid_content");
  const title = input.title,
    body = input.body;
  const video = await ports.openLocalVideo(input.mediaReferences[0]!, signal);
  try {
    if (
      !Number.isSafeInteger(video.size) ||
      video.size <= 0 ||
      video.size > 2 * 1024 ** 3
    )
      throw new XhsPreparationError("video_too_large");
    if (
      ![video.width, video.height].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 8192,
      ) ||
      video.width * video.height > 16777216 ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      !Number.isSafeInteger(Math.round(video.duration * 1000))
    )
      throw new XhsPreparationError("invalid_video");
    if (video.cover.byteLength > 20 * 1024 * 1024)
      throw new XhsPreparationError("image_too_large");
    const cover = new Uint8Array(video.cover);
    inspectImage(cover);
    await ports.verifyIdentity(signal);
    checkCancellation(signal);
    const permit = parseImagePermit(
      await ports.requestVideoPermit(signal),
      ports.allowedUploadHosts,
    );
    let id: string | undefined;
    const totalParts = Math.ceil(video.size / xhsVideoChunkBytes);
    const progress = (
      phase: XhsVideoProgress["phase"],
      partNumber: number,
      uploadedBytes: number,
      attempt = 1,
    ) =>
      onProgress?.({
        phase,
        partNumber,
        totalParts,
        uploadedBytes,
        totalBytes: video.size,
        attempt,
      });
    try {
      if (totalParts > 1) {
        const initialized = await ports.requestObject({
          permit,
          bytes: new Uint8Array(),
          mediaType: "video/mp4",
          operation: { kind: "init" },
          signal,
        });
        accepted(initialized);
        id = uploadId(initialized.body);
      }
      const parts: { partNumber: number; etag: string }[] = [];
      for (let partNumber = 1, offset = 0; offset < video.size; partNumber++) {
        checkCancellation(signal);
        const length = Math.min(xhsVideoChunkBytes, video.size - offset);
        // Only one bounded chunk is held, read once and reused for independent part retries.
        const bytes = await video.readPart(offset, length, signal);
        if (bytes.byteLength !== length)
          throw new XhsPreparationError("video_changed");
        for (let attempt = 1; attempt <= 3; attempt++) {
          checkCancellation(signal);
          let response: XhsObjectResponse;
          try {
            response = await ports.requestObject({
              permit,
              bytes,
              mediaType: "video/mp4",
              signal,
              operation: id
                ? { kind: "part", uploadId: id, partNumber }
                : { kind: "put" },
              onProgress: (uploaded) =>
                progress("upload", partNumber, offset + uploaded, attempt),
            });
          } catch (error) {
            checkCancellation(signal);
            if (
              error instanceof XhsPreparationError &&
              error.code === "upload_failed" &&
              attempt < 3
            )
              continue;
            throw error;
          }
          checkCancellation(signal);
          if (response.status >= 500 && attempt < 3) continue;
          accepted(response);
          if (id) {
            if (
              !response.etag ||
              !/^(?:[a-fA-F0-9-]{16,128}|"[a-fA-F0-9-]{16,128}")$/.test(
                response.etag,
              )
            )
              throw new XhsPreparationError("multipart_invalid");
            parts.push({ partNumber, etag: response.etag });
          }
          progress("upload", partNumber, offset + length, attempt);
          break;
        }
        offset += length;
      }
      checkCancellation(signal);
      if (id) {
        progress("merge", totalParts, video.size);
        const merged = await ports.requestObject({
          permit,
          operation: { kind: "complete", uploadId: id },
          mediaType: "application/xml",
          bytes: Buffer.from(buildXhsMultipartXml(parts), "utf8"),
          signal,
        });
        accepted(merged);
        if (
          !/<CompleteMultipartUploadResult(?:\s[^>]*)?>/.test(merged.body) ||
          /<Error[\s>]|<!DOCTYPE|<!ENTITY/i.test(merged.body)
        )
          throw new XhsPreparationError("multipart_invalid");
      }
    } catch (error) {
      // Abort only the multipart session, never delete a completed object or retry note creation.
      if (id)
        await ports
          .requestObject({
            permit,
            operation: { kind: "abort", uploadId: id },
            bytes: new Uint8Array(),
            mediaType: "video/mp4",
            signal: AbortSignal.timeout(10000),
          })
          .catch(() => {});
      throw error;
    }
    checkCancellation(signal);
    progress("cover", totalParts, video.size);
    const preparedCover = await prepareImageNote(
      { title, body, images: [{ resourceId: "video-cover", bytes: cover }] },
      ports,
      { signal },
    );
    const image = preparedCover.images[0]!;
    const metadata = {
      video: {
        duration: Math.round(video.duration * 1000),
        height: video.height,
        rotation: 0,
        width: video.width,
      },
      audio: {},
    };
    const fileId = permit.fileId;
    const candidate = {
      common: buildXhsCommonNote(title, body, "video"),
      image_info: null,
      video_info: {
        fileid: fileId,
        file_id: fileId,
        format_width: video.width,
        format_height: video.height,
        video_preview_type:
          video.height > video.width ? "full_vertical_screen" : "",
        composite_metadata: metadata,
        timelines: [],
        cover: {
          fileid: image.fileId,
          file_id: image.fileId,
          height: image.height,
          width: image.width,
          frame: { ts: 0, is_user_select: false, is_upload: false },
          stickers: { version: 2, neptune: [] },
          fonts: [],
          extra_info_json: "{}",
        },
        chapters: [],
        summary: "",
        chapter_sync_text: false,
        segments: {
          count: 1,
          need_slice: false,
          items: [
            {
              mute: 0,
              speed: 1,
              start: 0,
              duration: video.duration,
              transcoded: 0,
              media_source: 1,
              original_metadata: metadata,
            },
          ],
        },
        entrance: "web",
        pk_cover_biz_relations: [],
      },
    };
    return Object.freeze({
      serializedBody: JSON.stringify(candidate),
      submissionStatus: "not_submitted",
      fileId,
      coverFileId: image.fileId,
    });
  } finally {
    await video.close();
  }
}
export function createXhsVideoPublishSession(
  ports: XhsVideoPreparationPorts &
    Pick<XhsPublishSessionPorts, "signNote" | "close">,
): PluginPublishSession {
  return createXhsPreparedPublishSession(ports, (input, signal) =>
    prepareVideoNote(input, ports, signal),
  );
}
