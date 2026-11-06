import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const metadataFilename = "matrix-metadata.sqlite";
export const restoreJournalFilename = ".metadata-restore.json";
export const gateFilename = ".metadata-maintenance.sqlite";

export class MetadataMaintenanceError extends Error {
  override readonly name = "MetadataMaintenanceError";
}

export function assertRegularFile(filename: string): void {
  const value = lstatSync(filename);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1)
    throw new Error("数据库维护路径必须是普通文件，不能是链接");
}

/** A separate rollback-journal database holds the cross-process lock for the whole session. */
export function acquireMetadataGate(
  directory: string,
  allowRecovery = false,
): { release(): void } {
  const root = realpathSync(directory);
  const path = join(root, gateFilename);
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (pathExists(path + suffix)) assertRegularFile(path + suffix);
  const connection = new DatabaseSync(path);
  try {
    connection.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;",
    );
    if (!allowRecovery && pathExists(join(root, restoreJournalFilename)))
      throw new Error("数据库恢复尚未完成，请在 DevTools 中完成恢复或退回原库");
  } catch (error) {
    connection.close();
    throw new MetadataMaintenanceError(
      "数据库正在使用、维护或存在未完成恢复；请完全退出 Desktop 后检查 DevTools",
      { cause: error },
    );
  }
  let closed = false;
  return {
    release() {
      if (!closed) {
        connection.close();
        closed = true;
      }
    },
  };
}

const desktopGates = new Map<string, { count: number; release(): void }>();

/** Multiple repositories in one Desktop process share its lifetime lease. */
export function acquireDesktopMetadataGate(directory: string): {
  release(): void;
} {
  const root = realpathSync(directory);
  if (pathExists(join(root, restoreJournalFilename)))
    throw new MetadataMaintenanceError(
      "数据库存在未完成恢复，请在 DevTools 中处理",
    );
  let shared = desktopGates.get(root);
  if (!shared) {
    shared = { ...acquireMetadataGate(root), count: 0 };
    desktopGates.set(root, shared);
  }
  shared.count++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (--shared.count === 0) {
        shared.release();
        desktopGates.delete(root);
      }
    },
  };
}

export function verifySqliteIntegrity(connection: DatabaseSync): void {
  const results = connection.prepare("PRAGMA integrity_check").all();
  if (
    results.length !== 1 ||
    results[0]?.integrity_check !== "ok" ||
    connection.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Metadata integrity check failed");
}

export function vacuumMetadataInto(
  connection: DatabaseSync,
  destination: string,
): void {
  connection.prepare("VACUUM INTO ?").run(destination);
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    verifySqliteIntegrity(snapshot);
  } finally {
    snapshot.close();
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
