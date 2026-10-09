import { readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const LOG_FILE_PATTERN = /^diagnostics-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;
const LEGACY_LOG_FILE_PATTERN =
  /^automation-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;
const TRACE_DIRECTORY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DiagnosticRetentionOptions {
  readonly logDirectory: string;
  readonly evidenceDirectory: string;
  readonly activeLogPath?: string;
  readonly protectedTraceIds?: ReadonlySet<string>;
  readonly maxAgeMs?: number;
  readonly maxTotalBytes?: number;
  readonly now?: () => number;
  readonly legacy?: boolean;
}

interface Entry {
  path: string;
  modifiedAt: number;
  size: number;
  kind: "log" | "evidence";
  traceId?: string;
}

export async function enforceDiagnosticRetention(
  options: DiagnosticRetentionOptions,
): Promise<void> {
  const entries = [
    ...(await logEntries(options.logDirectory, options.legacy ?? false)),
    ...(await evidenceEntries(options.evidenceDirectory)),
  ];
  const protectedPaths = new Set(
    options.activeLogPath ? [resolve(options.activeLogPath)] : [],
  );
  const protectedTraceIds = options.protectedTraceIds ?? new Set<string>();
  const cutoff =
    (options.now ?? Date.now)() -
    (options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1_000);
  const removable = entries
    .filter(
      (entry) =>
        !protectedPaths.has(resolve(entry.path)) &&
        !(entry.traceId && protectedTraceIds.has(entry.traceId)),
    )
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
  const removed = new Set<string>();
  for (const entry of removable) {
    if (entry.modifiedAt >= cutoff) continue;
    await removeEntry(entry);
    removed.add(entry.path);
  }
  let total = entries
    .filter((entry) => !removed.has(entry.path))
    .reduce((sum, entry) => sum + entry.size, 0);
  const max = options.maxTotalBytes ?? 100 * 1024 * 1024;
  for (const entry of removable) {
    if (total <= max) break;
    if (removed.has(entry.path)) continue;
    await removeEntry(entry);
    removed.add(entry.path);
    total -= entry.size;
  }
}

async function logEntries(
  directory: string,
  legacy: boolean,
): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    if (
      !(legacy ? LEGACY_LOG_FILE_PATTERN : LOG_FILE_PATTERN).test(name) ||
      basename(name) !== name
    )
      continue;
    try {
      const meta = await stat(join(directory, name));
      if (meta.isFile())
        entries.push({
          path: join(directory, name),
          modifiedAt: meta.mtimeMs,
          size: meta.size,
          kind: "log",
        });
    } catch {
      /* concurrently removed */
    }
  }
  return entries;
}

async function evidenceEntries(directory: string): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const traceId of names) {
    if (!TRACE_DIRECTORY_PATTERN.test(traceId) || basename(traceId) !== traceId)
      continue;
    const path = join(directory, traceId);
    try {
      const meta = await stat(path);
      if (meta.isDirectory())
        entries.push({
          path,
          modifiedAt: meta.mtimeMs,
          size: await directorySize(path),
          kind: "evidence",
          traceId,
        });
    } catch {
      /* concurrently removed */
    }
  }
  return entries;
}

async function directorySize(directory: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!/^[0-9a-f-]+\.(?:png|json)$/i.test(name) || basename(name) !== name)
      continue;
    try {
      const meta = await stat(join(directory, name));
      if (meta.isFile()) total += meta.size;
    } catch {
      /* concurrently removed */
    }
  }
  return total;
}

async function removeEntry(entry: Entry): Promise<void> {
  await rm(
    entry.path,
    entry.kind === "log" ? { force: true } : { recursive: true, force: true },
  );
}
