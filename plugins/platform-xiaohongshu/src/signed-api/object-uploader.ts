import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LookupFunction } from "node:net";
import { XhsPreparationError, checkCancellation } from "./errors.js";
import { isPublicUploadAddress } from "./upload-target.js";
import type { XhsUploadPermit } from "./upload-target.js";
import type { XhsImagePreparationPorts } from "./image-preparation.js";

export type XhsObjectOperation =
  | { kind: "put" }
  | { kind: "init" }
  | { kind: "part"; uploadId: string; partNumber: number }
  | { kind: "complete" | "abort"; uploadId: string };
export interface XhsObjectResponse {
  status: number;
  body: string;
  etag?: string;
}
export type XhsObjectRequester = (input: {
  permit: XhsUploadPermit;
  operation: XhsObjectOperation;
  bytes: Uint8Array;
  mediaType:
    "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "application/xml";
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number) => void;
}) => Promise<XhsObjectResponse>;

export function createXhsObjectUploader(
  allowedHosts: readonly string[],
  timeoutMs = 120_000,
): XhsImagePreparationPorts["uploadImage"] {
  const request = createXhsObjectRequester(allowedHosts, timeoutMs);
  return ({ metadata, ...input }) =>
    request({
      ...input,
      operation: { kind: "put" },
      mediaType: metadata.mediaType,
    });
}

/** Direct object transport with validated/pinned DNS, bounded bodies and no authenticated cookie jar. */
export function createXhsObjectRequester(
  allowedHosts: readonly string[],
  timeoutMs = 120_000,
): XhsObjectRequester {
  return async ({
    permit,
    bytes,
    mediaType,
    operation,
    signal,
    onProgress,
  }) => {
    const startedAt = Date.now();
    checkCancellation(signal);
    const target = new URL(permit.url);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      (target.port && target.port !== "443") ||
      !allowedHosts.includes(target.hostname)
    )
      throw new XhsPreparationError("upload_target_rejected");
    let method = "PUT";
    if (operation.kind === "init") {
      method = "POST";
      target.search = "uploads";
    }
    if (
      operation.kind === "part" ||
      operation.kind === "complete" ||
      operation.kind === "abort"
    ) {
      if (!/^[a-zA-Z0-9._~-]{1,2048}$/.test(operation.uploadId))
        throw new XhsPreparationError("upload_target_rejected");
      target.searchParams.set("uploadId", operation.uploadId);
      if (operation.kind === "part") {
        if (
          !Number.isSafeInteger(operation.partNumber) ||
          operation.partNumber < 1 ||
          operation.partNumber > 10000
        )
          throw new XhsPreparationError("upload_target_rejected");
        target.searchParams.set("partNumber", String(operation.partNumber));
      }
      if (operation.kind === "complete") method = "POST";
      if (operation.kind === "abort") method = "DELETE";
    }
    let addresses;
    let lookupTimer: ReturnType<typeof setTimeout> | undefined;
    let abortLookup: (() => void) | undefined;
    try {
      addresses = await Promise.race([
        dnsLookup(target.hostname, { all: true }),
        new Promise<never>((_resolve, reject) => {
          lookupTimer = setTimeout(
            () => reject(new XhsPreparationError("upload_failed")),
            timeoutMs,
          );
          abortLookup = () => reject(new XhsPreparationError("cancelled"));
          signal?.addEventListener("abort", abortLookup, { once: true });
          if (signal?.aborted) abortLookup();
        }),
      ]);
    } catch (error) {
      checkCancellation(signal);
      if (error instanceof XhsPreparationError) throw error;
      throw new XhsPreparationError("upload_target_rejected");
    } finally {
      clearTimeout(lookupTimer);
      if (abortLookup) signal?.removeEventListener("abort", abortLookup);
    }
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicUploadAddress(address))
    )
      throw new XhsPreparationError("upload_target_rejected");
    checkCancellation(signal);
    const lookup: LookupFunction = (hostname, options, callback) => {
      if (hostname !== target.hostname) {
        callback(new Error("upload_target_rejected"), "", 0);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<XhsObjectResponse>((resolve, reject) => {
        const req = httpsRequest(
          target,
          {
            method,
            agent: false,
            lookup,
            headers: {
              "X-Cos-Security-Token": permit.token,
              "Content-Type": mediaType,
              "Content-Length": bytes.byteLength,
            },
            ...(signal ? { signal } : {}),
          },
          (response) => {
            let size = 0;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1_000_000)
                req.destroy(new Error("upload_response_too_large"));
              else chunks.push(Buffer.from(chunk));
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                ...(typeof response.headers.etag === "string"
                  ? { etag: response.headers.etag }
                  : {}),
              }),
            );
          },
        );
        timer = setTimeout(
          () => req.destroy(new Error("upload_timeout")),
          Math.max(1, timeoutMs - (Date.now() - startedAt)),
        );
        req.on("error", reject);
        // Yield 64 KiB chunks and honor writable backpressure; progress contains byte counts only.
        let uploaded = 0;
        async function* chunks() {
          for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
            checkCancellation(signal);
            const part = bytes.subarray(
              offset,
              Math.min(bytes.byteLength, offset + 64 * 1024),
            );
            yield part;
            uploaded += part.byteLength;
            onProgress?.(uploaded);
          }
        }
        void pipeline(Readable.from(chunks()), req).catch((error) => {
          req.destroy();
          reject(error);
        });
      });
    } catch {
      checkCancellation(signal);
      throw new XhsPreparationError("upload_failed");
    } finally {
      clearTimeout(timer);
    }
  };
}
