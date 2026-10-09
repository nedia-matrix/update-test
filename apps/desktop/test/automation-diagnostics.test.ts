import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DiagnosticStore,
  PendingDiagnosticRecord,
} from "@nedia-matrix/diagnostics";
import {
  enforceDiagnosticRetention,
  JsonlDiagnosticStore,
  redactDiagnosticRecord,
} from "@nedia-matrix/diagnostics";
import { DesktopDiagnosticTraceService } from "../src/main/diagnostics/desktop-diagnostic-trace-service.js";

function pending(
  overrides: Partial<PendingDiagnosticRecord> = {},
): PendingDiagnosticRecord {
  return {
    timestamp: "2026-09-15T00:00:00.000Z",
    level: "info",
    sequence: 1,
    traceId: "11111111-1111-4111-8111-111111111111",
    operation: "publication.prepare",
    component: "workflow",
    event: "workflow.started",
    publicationId: "publication-1",
    ...overrides,
  };
}

describe("automation diagnostic redaction", () => {
  it("removes credentials, content, paths, URL parameters, and unknown fields", () => {
    const record = redactDiagnosticRecord(
      pending({
        details: {
          url: "https://user:pass@example.test/publish?token=secret#draft",
          message:
            "Bearer abc123 token=secret /Users/test/private/image.png 13812345678",
          inputs: {
            body: { kind: "text", length: 6, value: "正文秘密" },
          },
          responseBody: "should disappear",
        },
      }),
    );
    const serialized = JSON.stringify(record);

    expect(record.details?.url).toBe("https://example.test/publish");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("/Users/test");
    expect(serialized).not.toContain("13812345678");
    expect(serialized).not.toContain("正文秘密");
    expect(serialized).not.toContain("responseBody");
  });
});

describe("JSONL automation log sink", () => {
  it("writes parseable records, rotates, and finds a publication trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-diagnostics-"));
    const directory = join(root, "logs");
    const sink = new JsonlDiagnosticStore({
      directory,
      maxFileBytes: 400,
      now: () => new Date("2026-09-15T00:00:00.000Z"),
    });

    for (let sequence = 1; sequence <= 8; sequence += 1) {
      sink.report(
        pending({
          sequence,
          event: `step.completed.${sequence}`,
          details: { durationMs: sequence },
        }),
      );
    }
    await sink.flush();

    const names = (await readdir(directory)).sort();
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const lines = (await readFile(join(directory, name), "utf8"))
        .trim()
        .split("\n");
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    }
    await expect(sink.findTraceForPublication("publication-1")).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    await sink.close();
  });

  it("reports queue pressure without blocking producers", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-diagnostics-drop-"));
    const dropped: number[] = [];
    const sink = new JsonlDiagnosticStore({
      directory: join(root, "logs"),
      maxQueueSize: 1,
      now: () => new Date("2026-09-15T00:00:00.000Z"),
      onRecordsDropped: (_traceId, counts) =>
        dropped.push(
          Object.values(counts).reduce((sum, value) => sum + value, 0),
        ),
    });

    sink.report(pending({ sequence: 1 }));
    sink.report(pending({ sequence: 2 }));
    sink.report(pending({ sequence: 3 }));
    await sink.flush();

    expect(dropped.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
    await sink.close();
  });

  it("keeps a warning by evicting a lower-priority queued record", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-diagnostics-priority-"));
    const dropped: Array<Readonly<Record<string, number>>> = [];
    const sink = new JsonlDiagnosticStore({
      directory: join(root, "logs"),
      maxQueueSize: 1,
      now: () => new Date("2026-09-15T00:00:00.000Z"),
      onRecordsDropped: (_traceId, counts) => dropped.push(counts),
    });

    sink.report(pending({ sequence: 1, level: "info", event: "info" }));
    sink.report(pending({ sequence: 2, level: "warn", event: "warning" }));
    await sink.flush();

    const contents = (
      await Promise.all(
        (await readdir(join(root, "logs"))).map((name) =>
          readFile(join(root, "logs", name), "utf8"),
        ),
      )
    ).join("");
    expect(contents).toContain('"event":"warning"');
    expect(dropped.some(({ info }) => info === 1)).toBe(true);
    await sink.close();
  });
});

describe("automation trace service", () => {
  it("correlates engine executions and publication IDs without leaking values", () => {
    const records: PendingDiagnosticRecord[] = [];
    const sink: DiagnosticStore = {
      report: (record) => records.push(record),
      flush: async () => undefined,
      close: async () => undefined,
      findTraceForPublication: async () => null,
      readTrace: async () => [],
    };
    const service = new DesktopDiagnosticTraceService(
      sink,
      () => new Date("2026-09-15T00:00:00.000Z"),
    );
    const trace = service.start({
      operation: "publication.prepare",
      accountId: "account-1",
      platformId: "douyin",
      requestId: "request-1",
    });
    trace.bind({ publicationId: "publication-1", pageId: "page-1" });
    const execution = trace.execution("prepare");
    execution.report({
      type: "workflow.started",
      workflowId: "douyin.prepare",
      pageDefinitionId: "publish-page",
      stepCount: 1,
      inputs: { body: { kind: "text", length: 20 } },
    });
    execution.report({
      type: "evidence.captured",
      workflowId: "douyin.prepare",
      evidenceId: "evidence-1",
      capturedAt: "2026-09-15T00:00:00.000Z",
      reasonCode: "workflow_failure",
      relativeRef: `evidence/${trace.traceId}/evidence-1.png`,
    });
    trace.finish({ outcome: "published" });

    expect(records.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(records[1]).toMatchObject({
      traceId: trace.traceId,
      executionId: execution.executionId,
      publicationId: "publication-1",
      pageId: "page-1",
      workflowId: "douyin.prepare",
      details: { phase: "prepare" },
    });
    expect(redactDiagnosticRecord(records[2]!)).toMatchObject({
      attachmentIds: ["evidence-1"],
      details: { relativeRef: `evidence/${trace.traceId}/evidence-1.png` },
    });
    expect(service.activeTraceIds()).not.toContain(trace.traceId);
  });
});

describe("automation diagnostic retention", () => {
  it("removes only expired recognized diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-retention-"));
    const logs = join(root, "logs");
    const evidence = join(root, "evidence");
    const traceId = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(evidence, traceId), { recursive: true });
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "diagnostics-2026-01-01.jsonl"), "{}\n");
    await writeFile(join(logs, "keep.txt"), "user file");
    await writeFile(join(evidence, traceId, "aaaa.png"), "png");
    const old = new Date("2026-01-01T00:00:00.000Z");
    const { utimes } = await import("node:fs/promises");
    await utimes(join(logs, "diagnostics-2026-01-01.jsonl"), old, old);
    await utimes(join(evidence, traceId), old, old);

    await enforceDiagnosticRetention({
      logDirectory: logs,
      evidenceDirectory: evidence,
      now: () => new Date("2026-09-15T00:00:00.000Z").getTime(),
    });

    await expect(stat(join(logs, "keep.txt"))).resolves.toBeDefined();
    await expect(
      stat(join(logs, "diagnostics-2026-01-01.jsonl")),
    ).rejects.toThrow();
    await expect(stat(join(evidence, traceId))).rejects.toThrow();
  });
});
