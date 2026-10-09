import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createZipArchive,
  DiagnosticAttachmentStore,
  DiagnosticTraceService,
  JsonlDiagnosticStore,
  type DiagnosticStore,
  type PendingDiagnosticRecord,
} from "../src/index.js";

function pending(
  overrides: Partial<PendingDiagnosticRecord> = {},
): PendingDiagnosticRecord {
  return {
    timestamp: "2026-09-22T00:00:00.000Z",
    level: "info",
    sequence: 1,
    traceId: "11111111-1111-4111-8111-111111111111",
    operation: "application.startup",
    component: "application",
    event: "trace.started",
    ...overrides,
  };
}

describe("local diagnostics", () => {
  it("stores screenshot bytes and controlled metadata under its trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-attachment-"));
    const traceId = pending().traceId;
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    const attachments = new DiagnosticAttachmentStore(join(root, "evidence"));
    const metadata = await attachments.saveScreenshot({
      traceId,
      png,
      reasonCode: "workflow_failure",
    });

    expect(metadata).toMatchObject({
      traceId,
      kind: "screenshot",
      byteSize: 24,
      width: 2,
      height: 3,
    });
    expect(metadata.relativeRef).toBe(`evidence/${traceId}/${metadata.id}.png`);
    expect(await readFile(join(root, metadata.relativeRef))).toEqual(png);
    await expect(
      attachments.readMetadata(traceId, metadata.id),
    ).resolves.toEqual(metadata);
    await expect(
      attachments.readMetadata("../outside", metadata.id),
    ).rejects.toThrow();
  });
  it("writes schema 2 records and reads a bounded trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostics-"));
    const store = new JsonlDiagnosticStore({
      directory: join(root, "logs"),
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    store.report(pending());
    await store.flush();

    const names = await readdir(join(root, "logs"));
    expect(names).toEqual(["diagnostics-2026-09-22.jsonl"]);
    const serialized = await readFile(join(root, "logs", names[0]!), "utf8");
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 2,
      operation: "application.startup",
    });
    await expect(
      store.readTrace("11111111-1111-4111-8111-111111111111", 10),
    ).resolves.toHaveLength(1);
    await store.close();
  });

  it("queries legacy schema 1 files without SQLite or migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostics-legacy-"));
    const legacy = join(root, "automation-logs");
    await mkdir(legacy, { recursive: true });
    await writeFile(
      join(legacy, "automation-2026-09-21.jsonl"),
      `${JSON.stringify({ ...pending({ publicationId: "publication-1" }), schemaVersion: 1 })}\n`,
    );
    const store = new JsonlDiagnosticStore({
      directory: join(root, "diagnostics", "logs"),
      legacyDirectories: [legacy],
    });

    await expect(store.findTraceForPublication("publication-1")).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    const records = await store.readTrace(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(records[0]).toMatchObject({
      schemaVersion: 2,
      eventId: "11111111-1111-4111-8111-111111111111:1",
    });
    await store.close();
  });

  it("keeps the publishing trace discoverable after a later notice trace", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "nedia-diagnostics-publication-"),
    );
    const store = new JsonlDiagnosticStore({ directory: join(root, "logs") });
    const traces = new DiagnosticTraceService(store);
    const publishing = traces.start({ operation: "publication.prepare" });
    publishing.bind({ publicationId: "publication-1" });
    publishing.finish({ outcome: "failed" });
    const notice = traces.start({ operation: "automation.notice" });
    notice.bind({ publicationId: "publication-1" });
    notice.finish({ outcome: "completed" });

    await expect(traces.findTraceForPublication("publication-1")).resolves.toBe(
      publishing.traceId,
    );
    await store.close();
    const reopened = new JsonlDiagnosticStore({
      directory: join(root, "logs"),
    });
    await expect(
      reopened.findTraceForPublication("publication-1"),
    ).resolves.toBe(publishing.traceId);
    await reopened.close();
  });

  it("paginates a trace across rotated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostics-pages-"));
    const store = new JsonlDiagnosticStore({
      directory: join(root, "logs"),
      maxFileBytes: 200,
    });
    for (let sequence = 1; sequence <= 5; sequence++)
      store.report(pending({ sequence }));
    await store.flush();
    const first = await store.readTrace(pending().traceId, 2);
    const second = await store.readTrace(
      pending().traceId,
      2,
      first[1]!.sequence,
    );
    expect(first.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(second.map(({ sequence }) => sequence)).toEqual([3, 4]);
    await store.close();
  });

  it("expires legacy logs and evidence without moving them", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostics-expire-"));
    const legacy = join(root, "automation-logs");
    const evidence = join(root, "automation-evidence");
    const traceId = pending().traceId;
    await mkdir(legacy);
    await mkdir(join(evidence, traceId), { recursive: true });
    const oldLog = join(legacy, "automation-2026-01-01.jsonl");
    await writeFile(oldLog, `${JSON.stringify(pending())}\n`);
    await writeFile(join(evidence, traceId, "aaaa.png"), "png");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(oldLog, old, old);
    await utimes(join(evidence, traceId), old, old);
    const store = new JsonlDiagnosticStore({
      directory: join(root, "diagnostics", "logs"),
      legacyDirectories: [legacy],
      legacyEvidenceDirectory: evidence,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    await store.flush();
    await expect(stat(oldLog)).rejects.toThrow();
    await expect(stat(join(evidence, traceId))).rejects.toThrow();
    await store.close();
  });

  it("rejects a query that would scan too many files", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "nedia-diagnostics-query-bound-"),
    );
    const directory = join(root, "logs");
    const store = new JsonlDiagnosticStore({ directory });
    await store.flush();
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(
          join(directory, `diagnostics-2026-09-22.${index + 1}.jsonl`),
          "",
        ),
      ),
    );
    await expect(store.readTrace(pending().traceId)).rejects.toThrow(
      "file limit",
    );
    await store.close();
  });

  it("keeps trace correlation independent from storage implementation", () => {
    const records: PendingDiagnosticRecord[] = [];
    const store: DiagnosticStore = {
      report: (record) => records.push(record),
      flush: async () => undefined,
      close: async () => undefined,
      findTraceForPublication: async () => null,
      readTrace: async () => [],
    };
    const traces = new DiagnosticTraceService(
      store,
      () => new Date("2026-09-22T00:00:00.000Z"),
    );
    const trace = traces.start({ operation: "account.verify" });
    trace.bind({ publicationId: "publication-1" });
    trace.finish({ outcome: "completed" });

    expect(records.map(({ event }) => event)).toEqual([
      "trace.started",
      "trace.completed",
    ]);
    expect(records.every(({ eventId }) => typeof eventId === "string")).toBe(
      true,
    );
  });

  it("creates a portable ZIP archive for trace exports", () => {
    const archive = createZipArchive([
      { name: "trace.jsonl", data: Buffer.from('{"event":"started"}\n') },
      { name: "evidence/image.png", data: Buffer.from([1, 2, 3]) },
    ]);

    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.includes(Buffer.from("trace.jsonl"))).toBe(true);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
  });

  it("reports unknown detail keys once without recording their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-diagnostics-fields-"));
    const warnings: string[][] = [];
    const store = new JsonlDiagnosticStore({
      directory: join(root, "logs"),
      onUnknownDetailKeys: (keys) => warnings.push([...keys]),
    });
    store.report(pending({ details: { unapprovedSecret: "do-not-write" } }));
    store.report(
      pending({
        sequence: 2,
        details: { unapprovedSecret: "still-do-not-write" },
      }),
    );
    await store.flush();

    expect(warnings).toEqual([["unapprovedSecret"]]);
    const [name] = await readdir(join(root, "logs"));
    expect(await readFile(join(root, "logs", name!), "utf8")).not.toContain(
      "do-not-write",
    );
    await store.close();
  });
});
