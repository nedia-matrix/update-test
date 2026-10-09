import { mkdir, writeFile } from "node:fs/promises";
import type {
  DiagnosticAttachment,
  DiagnosticTraceRecord,
  DiagnosticTraceReference,
  ExportDiagnosticTraceRequest,
  ExportDiagnosticTraceResult,
  FindDiagnosticTraceRequest,
  ReadDiagnosticTraceRequest,
  ReadDiagnosticAttachmentRequest,
} from "../../../bridge/contracts.js";
import {
  createZipArchive,
  DiagnosticAttachmentStore,
  redactDiagnosticRecord,
} from "@nedia-matrix/diagnostics";
import { ipcChannels } from "../../../bridge/channels.js";
import { dialog, ipcMain, shell } from "electron";
import {
  isSafeDiagnosticFileId,
  readDiagnosticAttachmentFile,
} from "../diagnostic-attachment-reader.js";

interface DiagnosticIpcDependencies {
  readonly logDirectory: string;
  readonly evidenceDirectories: readonly string[];
  findTraceForPublication(publicationId: string): Promise<string | null>;
  readTrace(
    traceId: string,
    limit?: number,
    afterSequence?: number,
  ): Promise<DiagnosticTraceRecord[]>;
}

export function registerDiagnosticIpc(
  dependencies: DiagnosticIpcDependencies,
): void {
  ipcMain.handle(ipcChannels.openDiagnosticDirectory, async () => {
    await mkdir(dependencies.logDirectory, { recursive: true });
    const error = await shell.openPath(dependencies.logDirectory);
    if (error) throw new Error(error);
  });
  ipcMain.handle(
    ipcChannels.findDiagnosticTrace,
    async (
      _event,
      request: FindDiagnosticTraceRequest,
    ): Promise<DiagnosticTraceReference | null> => {
      if (
        typeof request?.publicationId !== "string" ||
        !/^[A-Za-z0-9._~-]{1,128}$/.test(request.publicationId)
      ) {
        throw new TypeError("Invalid publication ID");
      }
      const traceId = await dependencies.findTraceForPublication(
        request.publicationId,
      );
      return traceId ? { traceId } : null;
    },
  );
  ipcMain.handle(
    ipcChannels.readDiagnosticTrace,
    async (
      _event,
      request: ReadDiagnosticTraceRequest,
    ): Promise<DiagnosticTraceRecord[]> => {
      if (
        typeof request?.traceId !== "string" ||
        !/^[A-Za-z0-9._~-]{1,128}$/.test(request.traceId) ||
        (request.limit !== undefined &&
          (!Number.isInteger(request.limit) ||
            request.limit < 1 ||
            request.limit > 2_000)) ||
        (request.afterSequence !== undefined &&
          (!Number.isInteger(request.afterSequence) ||
            request.afterSequence < 0))
      ) {
        throw new TypeError("Invalid diagnostic trace request");
      }
      return dependencies.readTrace(
        request.traceId,
        request.limit,
        request.afterSequence,
      );
    },
  );
  ipcMain.handle(
    ipcChannels.readDiagnosticAttachment,
    async (
      _event,
      request: ReadDiagnosticAttachmentRequest,
    ): Promise<DiagnosticAttachment | null> => {
      if (
        typeof request?.traceId !== "string" ||
        !isSafeDiagnosticFileId(request.traceId) ||
        typeof request?.attachmentId !== "string" ||
        !isSafeDiagnosticFileId(request.attachmentId)
      ) {
        throw new TypeError("Invalid diagnostic attachment request");
      }
      const event = await findAttachmentEvent(
        dependencies,
        request.traceId,
        request.attachmentId,
      );
      if (!event) return null;
      const data = await readDiagnosticAttachmentFile(
        dependencies.evidenceDirectories,
        request.traceId,
        request.attachmentId,
      );
      if (!data) return null;
      const stored = dependencies.evidenceDirectories[0]
        ? await new DiagnosticAttachmentStore(
            dependencies.evidenceDirectories[0],
          ).readMetadata(request.traceId, request.attachmentId)
        : null;
      if (stored && stored.byteSize !== data.byteLength) return null;
      const details = event.details;
      return {
        id: request.attachmentId,
        traceId: request.traceId,
        eventId: event.eventId,
        kind: "screenshot",
        mimeType: "image/png",
        relativeRef:
          stored?.relativeRef ??
          `${event.attachmentIds?.includes(request.attachmentId) ? "evidence" : "automation-evidence"}/${request.traceId}/${request.attachmentId}.png`,
        capturedAt:
          stored?.capturedAt ??
          (typeof details?.capturedAt === "string"
            ? details.capturedAt
            : event.timestamp),
        reasonCode:
          stored?.reasonCode ??
          (typeof details?.reasonCode === "string"
            ? details.reasonCode
            : "legacy_evidence"),
        byteSize: data.byteLength,
        ...(stored?.width !== undefined
          ? { width: stored.width }
          : typeof details?.width === "number"
            ? { width: details.width }
            : {}),
        ...(stored?.height !== undefined
          ? { height: stored.height }
          : typeof details?.height === "number"
            ? { height: details.height }
            : {}),
        dataBase64: data.toString("base64"),
      };
    },
  );
  ipcMain.handle(
    ipcChannels.exportDiagnosticTrace,
    async (
      _event,
      request: ExportDiagnosticTraceRequest,
    ): Promise<ExportDiagnosticTraceResult> => {
      if (
        typeof request?.traceId !== "string" ||
        !isSafeDiagnosticFileId(request.traceId)
      ) {
        throw new TypeError("Invalid diagnostic trace export request");
      }
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "导出本地诊断包",
        message: "诊断包可能包含平台页面截图",
        detail:
          "截图可能显示账号信息、页面正文或草稿内容。请仅将诊断包提供给你信任的支持人员。",
        buttons: ["继续导出", "取消"],
        defaultId: 1,
        cancelId: 1,
      });
      if (confirmation.response !== 0) return { exported: false };
      const records = await readAllTraceRecords(dependencies, request.traceId);
      const sanitizedRecords = records.map((record) =>
        redactDiagnosticRecord(record),
      );
      const entries: Array<{ name: string; data: Uint8Array }> = [
        {
          name: "trace.jsonl",
          data: Buffer.from(
            `${sanitizedRecords
              .map((record) => JSON.stringify(record))
              .join("\n")}\n`,
          ),
        },
      ];
      const attachmentIds = new Set(
        sanitizedRecords.flatMap((record) => [...(record.attachmentIds ?? [])]),
      );
      const attachmentManifest: Array<{
        attachmentId: string;
        eventIds: string[];
        metadata?: Readonly<Record<string, unknown>>;
      }> = [];
      let archiveBytes = entries[0]!.data.byteLength;
      for (const attachmentId of attachmentIds) {
        if (!isSafeDiagnosticFileId(attachmentId)) continue;
        const data = await readDiagnosticAttachmentFile(
          dependencies.evidenceDirectories,
          request.traceId,
          attachmentId,
        );
        if (!data) continue;
        archiveBytes += data.byteLength;
        if (archiveBytes > 100 * 1024 * 1024)
          throw new Error("Diagnostic trace export exceeds 100 MiB");
        entries.push({ name: `evidence/${attachmentId}.png`, data });
        const stored = dependencies.evidenceDirectories[0]
          ? await new DiagnosticAttachmentStore(
              dependencies.evidenceDirectories[0],
            ).readMetadata(request.traceId, attachmentId)
          : null;
        attachmentManifest.push({
          attachmentId,
          eventIds: sanitizedRecords
            .filter((record) => record.attachmentIds?.includes(attachmentId))
            .map((record) => record.eventId),
          ...(stored && stored.byteSize === data.byteLength
            ? { metadata: { ...stored } }
            : {}),
        });
      }
      entries.push({
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              traceId: request.traceId,
              recordCount: sanitizedRecords.length,
              attachments: attachmentManifest,
            },
            null,
            2,
          ),
        ),
      });
      const destination = await dialog.showSaveDialog({
        defaultPath: `diagnostic-${request.traceId}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (destination.canceled || !destination.filePath)
        return { exported: false };
      await writeFile(destination.filePath, createZipArchive(entries));
      return { exported: true };
    },
  );
}

async function findAttachmentEvent(
  dependencies: DiagnosticIpcDependencies,
  traceId: string,
  attachmentId: string,
): Promise<DiagnosticTraceRecord | null> {
  let afterSequence = 0;
  while (true) {
    const records = await dependencies.readTrace(traceId, 2_000, afterSequence);
    const event = records.find(
      (record) =>
        record.attachmentIds?.includes(attachmentId) ||
        record.details?.evidenceId === attachmentId,
    );
    if (event) return event;
    if (records.length < 2_000) return null;
    afterSequence = records[records.length - 1]!.sequence;
  }
}

async function readAllTraceRecords(
  dependencies: DiagnosticIpcDependencies,
  traceId: string,
): Promise<DiagnosticTraceRecord[]> {
  const records: DiagnosticTraceRecord[] = [];
  let afterSequence = 0;
  let bytes = 0;
  while (true) {
    const page = await dependencies.readTrace(traceId, 2_000, afterSequence);
    for (const record of page) {
      bytes += Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
      if (bytes > 100 * 1024 * 1024)
        throw new Error("Diagnostic trace export exceeds 100 MiB");
      records.push(record);
    }
    if (page.length < 2_000) return records;
    afterSequence = page[page.length - 1]!.sequence;
  }
}
