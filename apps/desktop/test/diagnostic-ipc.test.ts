import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticAttachmentStore } from "@nedia-matrix/diagnostics";
import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => Promise<unknown>>(),
);
const dialogs = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showSaveDialog: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler),
  },
  dialog: dialogs,
  shell: {},
}));

import { ipcChannels } from "../src/bridge/channels.js";
import { registerDiagnosticIpc } from "../src/main/diagnostics/ipc/register-diagnostic-ipc.js";

describe("diagnostic attachment IPC", () => {
  it("reads only an attachment referenced by the requested trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostic-ipc-"));
    const traceId = "11111111-1111-4111-8111-111111111111";
    const attachmentId = "22222222-2222-4222-8222-222222222222";
    await mkdir(join(root, traceId));
    await writeFile(
      join(root, traceId, `${attachmentId}.png`),
      Buffer.from([1, 2, 3]),
    );
    let referenced = false;
    registerDiagnosticIpc({
      logDirectory: root,
      evidenceDirectories: [root],
      findTraceForPublication: async () => null,
      readTrace: async () =>
        referenced
          ? [
              {
                schemaVersion: 2,
                timestamp: new Date().toISOString(),
                level: "error",
                sequence: 1,
                traceId,
                eventId: "event-1",
                operation: "publication.prepare",
                component: "evidence",
                event: "evidence.captured",
                attachmentIds: [attachmentId],
              },
            ]
          : [],
    });
    const read = handlers.get(ipcChannels.readDiagnosticAttachment)!;
    await expect(read(null, { traceId, attachmentId })).resolves.toBeNull();
    referenced = true;
    await expect(read(null, { traceId, attachmentId })).resolves.toMatchObject({
      id: attachmentId,
      traceId,
      eventId: "event-1",
      relativeRef: `evidence/${traceId}/${attachmentId}.png`,
      byteSize: 3,
      mimeType: "image/png",
      dataBase64: "AQID",
    });
  });

  it("exports the referenced screenshot with its stored metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostic-export-"));
    const traceId = "11111111-1111-4111-8111-111111111111";
    const evidenceRoot = join(root, "evidence");
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    const metadata = await new DiagnosticAttachmentStore(
      evidenceRoot,
    ).saveScreenshot({
      traceId,
      png,
      reasonCode: "workflow_failure",
    });
    registerDiagnosticIpc({
      logDirectory: root,
      evidenceDirectories: [evidenceRoot],
      findTraceForPublication: async () => traceId,
      readTrace: async () => [
        {
          schemaVersion: 2,
          timestamp: metadata.capturedAt,
          level: "error",
          sequence: 1,
          traceId,
          eventId: "event-1",
          operation: "publication.prepare",
          component: "evidence",
          event: "evidence.captured",
          attachmentIds: [metadata.id],
          details: {
            reasonCode: metadata.reasonCode,
            capturedAt: metadata.capturedAt,
          },
        },
      ],
    });
    const read = handlers.get(ipcChannels.readDiagnosticAttachment)!;
    await expect(
      read(null, { traceId, attachmentId: metadata.id }),
    ).resolves.toMatchObject({
      relativeRef: metadata.relativeRef,
      width: 2,
      height: 3,
    });
    const destination = join(root, "diagnostic.zip");
    dialogs.showMessageBox.mockResolvedValueOnce({ response: 0 });
    dialogs.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: destination,
    });
    const exportTrace = handlers.get(ipcChannels.exportDiagnosticTrace)!;
    await expect(exportTrace(null, { traceId })).resolves.toEqual({
      exported: true,
    });
    const archive = await readFile(destination);
    expect(archive.includes(Buffer.from(metadata.relativeRef))).toBe(true);
    expect(archive.includes(Buffer.from('"eventIds"'))).toBe(true);
    expect(archive.includes(Buffer.from('"event-1"'))).toBe(true);
    expect(
      archive.includes(Buffer.from('"reasonCode":"workflow_failure"')),
    ).toBe(true);
  });
});
