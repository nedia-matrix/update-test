import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isSafeDiagnosticFileId,
  readDiagnosticAttachmentFile,
} from "../src/main/diagnostics/diagnostic-attachment-reader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("diagnostic attachment reader", () => {
  it("reads only an attachment under its trace directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-evidence-"));
    roots.push(root);
    await mkdir(join(root, "trace-1"));
    await writeFile(join(root, "trace-1", "image-1.png"), Buffer.from("png"));

    await expect(
      readDiagnosticAttachmentFile([root], "trace-1", "image-1"),
    ).resolves.toEqual(Buffer.from("png"));
  });

  it("rejects traversal IDs and evidence symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-evidence-"));
    const outside = await mkdtemp(join(tmpdir(), "matrix-evidence-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "image-1.png"), Buffer.from("private"));
    await symlink(
      outside,
      join(root, "trace-1"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(isSafeDiagnosticFileId("..")).toBe(false);
    await expect(
      readDiagnosticAttachmentFile([root], "..", "image-1"),
    ).rejects.toThrow(TypeError);
    await expect(
      readDiagnosticAttachmentFile([root], "trace-1", "image-1"),
    ).resolves.toBeNull();
  });
});
