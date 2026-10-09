import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  DiagnosticLevel,
  DiagnosticRecord,
  DiagnosticStore,
  PendingDiagnosticRecord,
} from "./record.js";
import { redactDiagnosticRecord } from "./redaction.js";
import { enforceDiagnosticRetention } from "./retention.js";

const FILE_PATTERN = /^diagnostics-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const LEGACY_PATTERN = /^automation-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const MAX_QUERY_FILES = 256;
const MAX_QUERY_BYTES = 200 * 1024 * 1024;
const MAX_QUERY_LINE_BYTES = 16 * 1024;
export interface JsonlDiagnosticStoreOptions {
  directory: string;
  evidenceDirectory?: string;
  legacyDirectories?: readonly string[];
  legacyEvidenceDirectory?: string;
  maxFileBytes?: number;
  maxQueueSize?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  onUnknownDetailKeys?: (keys: readonly string[]) => void;
  protectedTraceIds?: () => ReadonlySet<string>;
  onRecordsDropped?: (
    traceId: string,
    counts: Readonly<Record<DiagnosticLevel, number>>,
  ) => void;
}
interface Queued {
  traceId: string;
  level: DiagnosticLevel;
  line: string;
  bytes: number;
}

export class JsonlDiagnosticStore implements DiagnosticStore {
  private readonly queue: Queued[] = [];
  private readonly dropped = new Map<string, Record<DiagnosticLevel, number>>();
  private readonly initialization: Promise<void>;
  private draining?: Promise<void>;
  private closed = false;
  private disabled = false;
  private reportedError = false;
  private readonly reportedUnknownDetailKeys = new Set<string>();
  private activeDate = "";
  private activeIndex = 0;
  private activeSize = 0;
  private retentionDate = "";
  constructor(private readonly options: JsonlDiagnosticStoreOptions) {
    this.initialization = this.initialize();
  }
  report(pending: PendingDiagnosticRecord): void {
    if (this.closed || this.disabled) return;
    let line: string;
    try {
      line = `${JSON.stringify(
        redactDiagnosticRecord(pending, (keys) => {
          const firstSeen = keys.filter(
            (key) => !this.reportedUnknownDetailKeys.has(key),
          );
          for (const key of firstSeen) this.reportedUnknownDetailKeys.add(key);
          if (firstSeen.length) this.options.onUnknownDetailKeys?.(firstSeen);
        }),
      )}\n`;
    } catch (error) {
      this.reportError(error);
      return;
    }
    const record = {
      traceId: pending.traceId,
      level: pending.level,
      line,
      bytes: Buffer.byteLength(line),
    };
    const capacity = this.options.maxQueueSize ?? 4096;
    if (
      this.queue.length >= Math.floor(capacity * 0.75) &&
      pending.level === "debug"
    ) {
      this.noteDropped(pending.traceId, pending.level);
      return;
    }
    if (this.queue.length >= capacity) {
      const index =
        pending.level === "warn" || pending.level === "error"
          ? this.queue.findIndex(
              ({ level }) => level === "debug" || level === "info",
            )
          : -1;
      if (index < 0) {
        this.noteDropped(pending.traceId, pending.level);
        return;
      }
      const [removed] = this.queue.splice(index, 1);
      if (removed) this.noteDropped(removed.traceId, removed.level);
    }
    this.queue.push(record);
    this.startDrain();
  }
  async flush() {
    await this.initialization;
    while (this.draining) await this.draining;
    if (this.queue.length && !this.disabled) {
      this.startDrain();
      while (this.draining) await this.draining;
    }
  }
  async close() {
    this.closed = true;
    await this.flush();
  }
  async findTraceForPublication(id: string) {
    if (!validId(id)) throw new TypeError("Invalid publication ID");
    return this.findPublication(id);
  }
  async readTrace(
    id: string,
    limit = 2_000,
    afterSequence = 0,
  ): Promise<DiagnosticRecord[]> {
    if (
      !validId(id) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 2_000 ||
      !Number.isInteger(afterSequence) ||
      afterSequence < 0
    )
      throw new TypeError("Invalid trace query");
    await this.flush();
    const records: DiagnosticRecord[] = [];
    for (const path of (await this.paths()).reverse()) {
      for await (const line of readLines(path)) {
        if (!line || !line.includes(id)) continue;
        try {
          const value = normalizeRecord(JSON.parse(line));
          if (value?.traceId === id && value.sequence > afterSequence)
            records.push(value);
        } catch {
          /* damaged line */
        }
        if (records.length >= limit)
          return records.sort((a, b) => a.sequence - b.sequence);
      }
    }
    return records.sort((a, b) => a.sequence - b.sequence);
  }
  private async findPublication(id: string) {
    await this.flush();
    let fallback: string | null = null;
    for (const path of await this.paths()) {
      for await (const line of readLines(path)) {
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          if (record.publicationId !== id || typeof record.traceId !== "string")
            continue;
          if (record.operation === "publication.prepare") return record.traceId;
          fallback ??= record.traceId;
        } catch {
          /* damaged line */
        }
      }
    }
    return fallback;
  }
  private async paths() {
    const directories = [
      this.options.directory,
      ...(this.options.legacyDirectories ?? []),
    ];
    const paths: string[] = [];
    for (const directory of directories) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of names
        .filter((n) => FILE_PATTERN.test(n) || LEGACY_PATTERN.test(n))
        .sort(compareDiagnosticFilenames)
        .reverse())
        paths.push(join(directory, name));
    }
    if (paths.length > MAX_QUERY_FILES)
      throw new Error("Diagnostic query exceeds file limit");
    let bytes = 0;
    for (const path of paths) {
      bytes += (await stat(path)).size;
      if (bytes > MAX_QUERY_BYTES)
        throw new Error("Diagnostic query exceeds byte limit");
    }
    return paths;
  }
  private startDrain() {
    if (this.draining || !this.queue.length || this.disabled) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length && !this.closed && !this.disabled)
        this.startDrain();
    });
  }
  private async drain() {
    try {
      await this.initialization;
      if (this.disabled) return;
      while (this.queue.length) {
        const record = this.queue.shift()!;
        await this.prepare(record.bytes);
        await appendFile(this.activePath(), record.line, "utf8");
        this.activeSize += record.bytes;
      }
      this.emitDropped();
    } catch (error) {
      this.disabled = true;
      this.queue.length = 0;
      this.reportError(error);
    }
  }
  private async initialize() {
    const today = this.dateKey();
    try {
      await mkdir(this.options.directory, { recursive: true });
      await this.select(today);
    } catch (error) {
      this.disabled = true;
      this.reportError(error);
      return;
    }
    await this.retain(today, true);
  }
  private async prepare(bytes: number) {
    const today = this.dateKey();
    if (this.activeDate !== today) {
      await this.select(today);
      await this.retain(today);
    }
    const max = this.options.maxFileBytes ?? 10 * 1024 * 1024;
    if (this.activeSize > 0 && this.activeSize + bytes > max) {
      this.activeIndex++;
      this.activeSize = await fileSize(this.activePath());
      await this.retain(today, true);
    }
  }
  private async select(today: string) {
    this.activeDate = today;
    let names: string[] = [];
    try {
      names = await readdir(this.options.directory);
    } catch {
      /* created during init */
    }
    const indexes = names.flatMap((name) => {
      const match = FILE_PATTERN.exec(name);
      return match?.[1] === today ? [Number(match[2] ?? 0)] : [];
    });
    this.activeIndex = indexes.length ? Math.max(...indexes) : 0;
    this.activeSize = await fileSize(this.activePath());
    if (this.activeSize >= (this.options.maxFileBytes ?? 10 * 1024 * 1024)) {
      this.activeIndex++;
      this.activeSize = await fileSize(this.activePath());
    }
  }
  private activePath() {
    return join(
      this.options.directory,
      `diagnostics-${this.activeDate}${this.activeIndex ? `.${this.activeIndex}` : ""}.jsonl`,
    );
  }
  private dateKey() {
    return (this.options.now ?? (() => new Date()))()
      .toISOString()
      .slice(0, 10);
  }
  private noteDropped(id: string, level: DiagnosticLevel) {
    const counts = this.dropped.get(id) ?? {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };
    counts[level]++;
    this.dropped.set(id, counts);
  }
  private emitDropped() {
    if (!this.options.onRecordsDropped) return;
    const values = [...this.dropped];
    this.dropped.clear();
    for (const [id, counts] of values)
      try {
        this.options.onRecordsDropped(id, counts);
      } catch {
        /* best effort */
      }
  }
  private async retain(today: string, force = false) {
    if (!force && this.retentionDate === today) return;
    this.retentionDate = today;
    try {
      await enforceDiagnosticRetention({
        logDirectory: this.options.directory,
        evidenceDirectory:
          this.options.evidenceDirectory ??
          join(this.options.directory, "..", "evidence"),
        activeLogPath: this.activePath(),
        protectedTraceIds: this.options.protectedTraceIds?.(),
        now: () => (this.options.now ?? (() => new Date()))().getTime(),
      });
      for (const legacyDirectory of this.options.legacyDirectories ?? []) {
        await enforceDiagnosticRetention({
          logDirectory: legacyDirectory,
          evidenceDirectory:
            this.options.legacyEvidenceDirectory ??
            join(legacyDirectory, "..", "automation-evidence"),
          protectedTraceIds: this.options.protectedTraceIds?.(),
          now: () => (this.options.now ?? (() => new Date()))().getTime(),
          legacy: true,
        });
      }
    } catch (error) {
      this.reportError(error);
    }
  }
  private reportError(error: unknown) {
    if (this.reportedError) return;
    this.reportedError = true;
    this.options.onError?.(error);
  }
}
async function* readLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) <= MAX_QUERY_LINE_BYTES) yield line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}
function validId(value: string) {
  return /^[A-Za-z0-9._~-]{1,128}$/.test(value);
}
function compareDiagnosticFilenames(a: string, b: string): number {
  const left = FILE_PATTERN.exec(a) ?? LEGACY_PATTERN.exec(a);
  const right = FILE_PATTERN.exec(b) ?? LEGACY_PATTERN.exec(b);
  const date = left![1]!.localeCompare(right![1]!);
  return date || Number(left![2] ?? 0) - Number(right![2] ?? 0);
}
async function fileSize(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function normalizeRecord(value: unknown): DiagnosticRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<DiagnosticRecord>;
  if (
    typeof record.traceId !== "string" ||
    typeof record.sequence !== "number" ||
    typeof record.timestamp !== "string" ||
    typeof record.level !== "string" ||
    typeof record.operation !== "string" ||
    typeof record.component !== "string" ||
    typeof record.event !== "string"
  ) {
    return null;
  }
  return {
    ...(record as DiagnosticRecord),
    schemaVersion: 2,
    eventId:
      typeof record.eventId === "string"
        ? record.eventId
        : `${record.traceId}:${record.sequence}`,
  };
}
