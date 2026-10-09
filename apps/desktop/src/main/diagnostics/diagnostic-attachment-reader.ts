import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const safeFileId = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function isSafeDiagnosticFileId(value: unknown): value is string {
  return typeof value === "string" && safeFileId.test(value);
}

export async function readDiagnosticAttachmentFile(
  directories: readonly string[],
  traceId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  if (
    !isSafeDiagnosticFileId(traceId) ||
    !isSafeDiagnosticFileId(attachmentId)
  ) {
    throw new TypeError("Invalid diagnostic attachment ID");
  }
  for (const directory of directories) {
    const filename = join(directory, traceId, `${attachmentId}.png`);
    try {
      const [root, resolved] = await Promise.all([
        realpath(directory),
        realpath(filename),
      ]);
      if (!resolved.startsWith(`${root}${sep}`)) return null;
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.size > MAX_ATTACHMENT_BYTES)
        return null;
      return readFile(resolved);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}
