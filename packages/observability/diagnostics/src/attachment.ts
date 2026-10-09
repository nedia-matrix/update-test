import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export interface DiagnosticAttachmentMetadata {
  readonly id: string;
  readonly traceId: string;
  readonly kind: "screenshot";
  readonly mimeType: "image/png";
  readonly relativeRef: string;
  readonly capturedAt: string;
  readonly reasonCode: string;
  readonly byteSize: number;
  readonly width?: number;
  readonly height?: number;
}

/** Owns screenshot names, relative references, and metadata beside each PNG. */
export class DiagnosticAttachmentStore {
  constructor(private readonly evidenceRoot: string) {}

  async saveScreenshot(input: {
    traceId: string;
    png: Uint8Array;
    reasonCode: string;
    capturedAt?: string;
  }): Promise<DiagnosticAttachmentMetadata> {
    if (
      !SAFE_ID.test(input.traceId) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(input.reasonCode)
    )
      throw new TypeError("Invalid diagnostic attachment context");
    const capturedAt = input.capturedAt ?? new Date().toISOString();
    if (!isIsoTimestamp(capturedAt))
      throw new TypeError("Invalid diagnostic capture time");
    const png = Buffer.from(input.png);
    if (
      png.byteLength < 24 ||
      png.byteLength > MAX_SCREENSHOT_BYTES ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
      png.readUInt32BE(12) !== 0x49484452
    )
      throw new TypeError("Invalid diagnostic screenshot");
    const id = randomUUID();
    const directory = join(this.evidenceRoot, input.traceId);
    const metadata: DiagnosticAttachmentMetadata = {
      id,
      traceId: input.traceId,
      kind: "screenshot",
      mimeType: "image/png",
      relativeRef: `evidence/${input.traceId}/${id}.png`,
      capturedAt,
      reasonCode: input.reasonCode,
      byteSize: png.byteLength,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    };
    await mkdir(directory, { recursive: true });
    const imagePath = join(directory, `${id}.png`);
    try {
      await writeFile(imagePath, png, { flag: "wx" });
      await writeFile(join(directory, `${id}.json`), JSON.stringify(metadata), {
        flag: "wx",
      });
    } catch (error) {
      await rm(imagePath, { force: true }).catch(() => undefined);
      throw error;
    }
    return metadata;
  }

  async readMetadata(
    traceId: string,
    id: string,
  ): Promise<DiagnosticAttachmentMetadata | null> {
    if (!SAFE_ID.test(traceId) || !SAFE_ID.test(id))
      throw new TypeError("Invalid diagnostic attachment ID");
    const path = join(this.evidenceRoot, traceId, `${id}.json`);
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.size > 4_096) return null;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object") return null;
      const metadata = value as Partial<DiagnosticAttachmentMetadata>;
      if (
        metadata.id !== id ||
        metadata.traceId !== traceId ||
        metadata.kind !== "screenshot" ||
        metadata.mimeType !== "image/png" ||
        metadata.relativeRef !== `evidence/${traceId}/${id}.png` ||
        !isIsoTimestamp(metadata.capturedAt) ||
        typeof metadata.reasonCode !== "string" ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(metadata.reasonCode) ||
        typeof metadata.byteSize !== "number" ||
        !Number.isInteger(metadata.byteSize) ||
        metadata.byteSize < 24 ||
        metadata.byteSize > MAX_SCREENSHOT_BYTES ||
        (metadata.width !== undefined &&
          (!Number.isInteger(metadata.width) || metadata.width <= 0)) ||
        (metadata.height !== undefined &&
          (!Number.isInteger(metadata.height) || metadata.height <= 0))
      )
        return null;
      return {
        id,
        traceId,
        kind: "screenshot",
        mimeType: "image/png",
        relativeRef: metadata.relativeRef,
        capturedAt: metadata.capturedAt,
        reasonCode: metadata.reasonCode,
        byteSize: metadata.byteSize,
        ...(typeof metadata.width === "number"
          ? { width: metadata.width }
          : {}),
        ...(typeof metadata.height === "number"
          ? { height: metadata.height }
          : {}),
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
