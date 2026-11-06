import { createReadStream } from "node:fs";
import { opendir, realpath, stat, readFile } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  isAbsolute,
  resolve,
} from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { normalizeRecord } from "./normalize-record.js";
import { readZipArchive } from "./zip-archive.js";
import type { DiagnosticRecord } from "./record.js";

import type {
  DiagnosticSource,
  DiagnosticQuery,
  DiagnosticQueryResult,
  DiagnosticFilter,
} from "./reader-contracts.js";
export type * from "./reader-contracts.js";

const MAX_FILES = 256;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_LINE = 16 * 1024;
const MAX_RECORDS = 10_000;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};

/** A source owns only read handles; construction never creates or cleans files. */
export class ReadonlyDiagnosticReader {
  readonly source: DiagnosticSource;
  private constructor(
    path: string,
    kind: DiagnosticSource["kind"],
    private readonly files: string[] = [],
    private readonly archive?: Map<string, Buffer>,
  ) {
    this.source = { id: randomUUID(), label: basename(path), path, kind };
  }
  static async directory(path: string) {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error("请选择目录");
    return new ReadonlyDiagnosticReader(root, "directory");
  }
  static async files(paths: string[]) {
    if (!paths.length || paths.length > MAX_FILES)
      throw new Error("请选择 1–256 个 JSONL");
    const files: string[] = [];
    for (const path of paths) {
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isFile() || !/\.jsonl$/i.test(resolved))
        throw new Error("请选择 JSONL 文件");
      files.push(resolved);
    }
    return new ReadonlyDiagnosticReader(files[0]!, "files", [
      ...new Set(files),
    ]);
  }
  static async zip(path: string) {
    const resolved = await realpath(path);
    if ((await stat(resolved)).size > 100 * 1024 * 1024)
      throw new Error("ZIP 超过 100 MiB");
    const archive = readZipArchive(await readFile(resolved));
    const manifest = archive.get("manifest.json");
    if (!manifest || !archive.has("trace.jsonl"))
      throw new Error("诊断 ZIP 缺少 manifest.json 或 trace.jsonl");
    const value = JSON.parse(manifest.toString("utf8"));
    if (value.schemaVersion !== 1 || typeof value.traceId !== "string")
      throw new Error("未知诊断包版本或无效 manifest");
    return new ReadonlyDiagnosticReader(resolved, "zip", [], archive);
  }
  async query(
    query: DiagnosticQuery = {},
    signal?: AbortSignal,
  ): Promise<DiagnosticQueryResult> {
    validateQuery(query);
    const result: DiagnosticQueryResult = {
      records: [],
      matched: 0,
      scannedBytes: 0,
      scannedFiles: 0,
      issues: {},
      truncated: false,
      cancelled: false,
    };
    const issue = (name: string) => {
      result.issues[name] = (result.issues[name] ?? 0) + 1;
    };
    const paths = await this.paths(issue, signal);
    if (
      result.issues.fileLimit ||
      result.issues.directoryLimit ||
      result.issues.readFailure
    )
      result.truncated = true;
    outer: for (const path of paths) {
      if (signal?.aborted) {
        result.cancelled = true;
        break;
      }
      result.scannedFiles++;
      let pending = Buffer.alloc(0);
      let oversized = false;
      const consume = (line: Buffer) => {
        if (!line.length) return;
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          issue("damagedLine");
          return;
        }
        if (
          value &&
          typeof value === "object" &&
          "schemaVersion" in value &&
          ![1, 2].includes(value.schemaVersion as number)
        ) {
          issue("unknownVersion");
          return;
        }
        const record = normalizeRecord(value);
        if (!record || !validRecord(record)) {
          issue("invalidRecord");
          return;
        }
        if (!matches(record, query.filter ?? {})) return;
        result.matched++;
        if (result.records.length < MAX_RECORDS)
          result.records.push({
            ...record,
            timestamp: new Date(record.timestamp).toISOString(),
          });
        else {
          result.truncated = true;
          issue("recordLimit");
        }
      };
      try {
        const stream = this.archive
          ? Readable.from([this.archive.get(path)!])
          : createReadStream(path, { highWaterMark: 64 * 1024 });
        try {
          for await (const data of stream) {
            if (signal?.aborted) {
              result.cancelled = true;
              break outer;
            }
            const chunk = Buffer.from(data);
            result.scannedBytes += chunk.length;
            if (result.scannedBytes > MAX_BYTES) {
              result.truncated = true;
              issue("byteLimit");
              break outer;
            }
            let start = 0;
            for (let i = 0; i < chunk.length; i++) {
              if (chunk[i] !== 10) continue;
              const part = chunk.subarray(start, i);
              if (!oversized && pending.length + part.length <= MAX_LINE)
                consume(Buffer.concat([pending, part]));
              else issue("oversizedLine");
              pending = Buffer.alloc(0);
              oversized = false;
              start = i + 1;
            }
            const tail = chunk.subarray(start);
            if (pending.length + tail.length > MAX_LINE) {
              oversized = true;
              pending = Buffer.alloc(0);
            }
            if (!oversized) pending = Buffer.concat([pending, tail]);
          }
        } finally {
          stream.destroy();
        }
        if (oversized) issue("oversizedLine");
        else if (pending.length) {
          // A final valid JSON record is readable; a partial write is retried on the next query.
          try {
            JSON.parse(pending.toString("utf8"));
            consume(pending);
          } catch {
            issue("incompleteTail");
          }
        }
      } catch {
        issue("readFailure");
        result.truncated = true;
      }
    }
    if (signal?.aborted) result.cancelled = true;
    const filterTrace = query.filter?.traceId;
    result.records.sort(
      filterTrace
        ? (a, b) => a.sequence - b.sequence
        : (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
    );
    const offset = query.offset ?? 0;
    result.records = result.records.slice(
      offset,
      offset + (query.limit ?? 200),
    );
    return result;
  }
  async assertExportDestination(path: string) {
    const parent = await realpath(dirname(path));
    const destination = resolve(parent, basename(path));
    const roots =
      this.source.kind === "directory"
        ? [this.source.path]
        : this.source.kind === "files"
          ? this.files.map(dirname)
          : [];
    if (
      destination === this.source.path ||
      roots.some((root) => inside(root, destination))
    )
      throw new Error("导出位置必须在来源目录之外");
  }
  async attachment(
    traceId: string,
    attachmentId: string,
  ): Promise<Buffer | null> {
    if (!safeId.test(traceId) || !safeId.test(attachmentId))
      throw new TypeError("无效附件 ID");
    if (this.archive)
      return this.archive.get(`evidence/${attachmentId}.png`) ?? null;
    const roots =
      this.source.kind === "files"
        ? [...new Set(this.files.map(dirname))]
        : [this.source.path];
    for (const root of roots) {
      for (const folder of [
        "evidence",
        "diagnostics/evidence",
        "automation-evidence",
      ]) {
        const boundary = root;
        try {
          const path = await realpath(
            join(root, folder, traceId, `${attachmentId}.png`),
          );
          if (!inside(boundary, path)) continue;
          const metadata = await stat(path);
          if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024) continue;
          return await readFile(path);
        } catch {
          /* Expired, unreadable or out of bounds. */
        }
      }
    }
    return null;
  }
  private async paths(
    issue: (name: string) => void,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (this.archive) return ["trace.jsonl"];
    if (this.source.kind === "files") return this.files;
    const root = this.source.path;
    const paths: string[] = [];
    let entries = 0;
    for (const subdir of ["", "logs", "diagnostics/logs", "automation-logs"]) {
      try {
        const folder = await realpath(join(root, subdir));
        if (!inside(root, folder)) {
          issue("outsideSource");
          continue;
        }
        for await (const entry of await opendir(folder)) {
          if (signal?.aborted) return paths;
          if (++entries > 4096) {
            issue("directoryLimit");
            return paths;
          }
          if (!entry.name.endsWith(".jsonl")) continue;
          if (!entry.isFile()) {
            issue("outsideSource");
            continue;
          }
          if (paths.length === MAX_FILES) {
            issue("fileLimit");
            return paths;
          }
          const path = await realpath(join(folder, entry.name));
          if (inside(root, path)) paths.push(path);
          else issue("outsideSource");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          issue("readFailure");
      }
    }
    return paths.sort();
  }
}
function validRecord(record: DiagnosticRecord) {
  return (
    Number.isSafeInteger(record.sequence) &&
    record.sequence > 0 &&
    Number.isFinite(Date.parse(record.timestamp)) &&
    ["debug", "info", "warn", "error"].includes(record.level) &&
    [
      "eventId",
      "executionId",
      "platformId",
      "accountId",
      "requestId",
      "publicationId",
      "pageId",
      "workflowId",
    ].every(
      (key) =>
        !(key in record) ||
        typeof record[key as keyof DiagnosticRecord] === "string",
    ) &&
    (record.details === undefined ||
      (!!record.details &&
        typeof record.details === "object" &&
        !Array.isArray(record.details))) &&
    (record.attachmentIds === undefined ||
      (Array.isArray(record.attachmentIds) &&
        record.attachmentIds.every((id) => typeof id === "string")))
  );
}
function matches(record: DiagnosticRecord, filter: DiagnosticFilter) {
  for (const key of [
    "level",
    "operation",
    "component",
    "event",
    "platformId",
    "traceId",
  ] as const)
    if (filter[key] && record[key] !== filter[key]) return false;
  if (filter.from && Date.parse(record.timestamp) < Date.parse(filter.from))
    return false;
  if (filter.to && Date.parse(record.timestamp) > Date.parse(filter.to))
    return false;
  if (
    filter.correlationId &&
    ![
      record.traceId,
      record.eventId,
      record.executionId,
      record.accountId,
      record.requestId,
      record.publicationId,
      record.pageId,
      record.workflowId,
    ].includes(filter.correlationId)
  )
    return false;
  return (
    !filter.text ||
    JSON.stringify(record).toLowerCase().includes(filter.text.toLowerCase())
  );
}
function validateQuery(query: DiagnosticQuery) {
  if (
    !query ||
    typeof query !== "object" ||
    !Number.isInteger(query.offset ?? 0) ||
    (query.offset ?? 0) < 0 ||
    (query.offset ?? 0) > MAX_RECORDS ||
    !Number.isInteger(query.limit ?? 200) ||
    (query.limit ?? 200) < 1 ||
    (query.limit ?? 200) > MAX_RECORDS
  )
    throw new TypeError("无效查询分页");
  if (
    query.filter !== undefined &&
    (!query.filter ||
      typeof query.filter !== "object" ||
      Array.isArray(query.filter))
  )
    throw new TypeError("无效筛选条件");
  for (const [key, value] of Object.entries(query.filter ?? {})) {
    if (
      ![
        "text",
        "level",
        "operation",
        "component",
        "event",
        "platformId",
        "correlationId",
        "traceId",
        "from",
        "to",
      ].includes(key) ||
      typeof value !== "string" ||
      value.length > 2048
    )
      throw new TypeError("无效筛选条件");
    if (
      (key === "from" || key === "to") &&
      value &&
      !Number.isFinite(Date.parse(value))
    )
      throw new TypeError("无效时间");
  }
}
