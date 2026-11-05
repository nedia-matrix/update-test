import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metadataSchemaVersion } from "../persistence/schema-version.js";
import { pluginProtocolVersions } from "../plugins/plugin-protocol.mjs";

import { runtimeCompatibility } from "./runtime-support.js";
export { runtimeCompatibility } from "./runtime-support.js";

export const compatibilityFileName = "runtime-compatibility.json";
interface Requirements {
  engineProtocol: number;
  metadataSchemaVersion: number;
  pluginProtocol: number;
  pluginSdk: number;
  automationProtocol: number;
  capabilities: string[];
}
interface Declaration {
  schemaVersion: 1;
  requirements: Requirements;
}
export class RuntimeCompatibilityError extends Error {
  readonly code = "RUNTIME_DATA_INCOMPATIBLE";
  constructor(readonly reason: string) {
    super(
      `当前桌面版本无法安全使用这份业务数据（${reason}）。请安装兼容版本后重试；请勿删除数据、降级数据库或重复发布。`,
    );
    this.name = "RuntimeCompatibilityError";
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readJson(path: string): unknown | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error("Invalid metadata file");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RuntimeCompatibilityError("无法读取兼容信息");
  }
}
function requirementsForThisRuntime(): Requirements {
  return {
    engineProtocol: runtimeCompatibility.engineProtocol,
    metadataSchemaVersion: metadataSchemaVersion,
    pluginProtocol: runtimeCompatibility.pluginProtocol,
    pluginSdk: runtimeCompatibility.pluginSdk,
    automationProtocol: runtimeCompatibility.automationProtocol,
    capabilities: [...runtimeCompatibility.capabilities].sort(),
  };
}
function supportedDeclaration(value: unknown): Declaration | undefined {
  if (value === undefined) return undefined;
  const expected = requirementsForThisRuntime();
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !object(value.requirements) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "requirements"].includes(key),
    ) ||
    Object.keys(value.requirements).some((key) => !Object.hasOwn(expected, key))
  ) {
    throw new RuntimeCompatibilityError("兼容声明格式不受支持");
  }
  const required = value.requirements;
  for (const key of [
    "engineProtocol",
    "pluginProtocol",
    "pluginSdk",
    "automationProtocol",
  ] as const) {
    if (required[key] !== expected[key])
      throw new RuntimeCompatibilityError("业务或插件协议不受支持");
  }
  if (
    !Number.isSafeInteger(required.metadataSchemaVersion) ||
    (required.metadataSchemaVersion as number) < 0 ||
    (required.metadataSchemaVersion as number) > metadataSchemaVersion
  ) {
    throw new RuntimeCompatibilityError("所需数据库版本不受支持");
  }
  if (
    !Array.isArray(required.capabilities) ||
    required.capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !runtimeCompatibility.capabilities.includes(capability),
    )
  ) {
    throw new RuntimeCompatibilityError("缺少所需业务能力");
  }
  return value as unknown as Declaration;
}
function optionalStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inspectDatabase(directory: string): void {
  const source = join(directory, "matrix-metadata.sqlite");
  const stat = optionalStat(source);
  if (!stat) {
    if (
      optionalStat(`${source}-wal`) ||
      optionalStat(`${source}-shm`) ||
      optionalStat(`${source}-journal`)
    )
      throw new RuntimeCompatibilityError("数据库文件缺失但恢复文件仍存在");
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new RuntimeCompatibilityError("数据库路径不受支持");
  const temporary = mkdtempSync(join(tmpdir(), "nedia-compatibility-"));
  try {
    const snapshot = join(temporary, "metadata.sqlite");
    copyFileSync(source, snapshot, constants.COPYFILE_FICLONE);
    for (const suffix of ["-wal", "-journal"]) {
      const recovery = optionalStat(`${source}${suffix}`);
      if (recovery) {
        if (!recovery.isFile() || recovery.isSymbolicLink())
          throw new RuntimeCompatibilityError("数据库恢复文件不受支持");
        copyFileSync(
          `${source}${suffix}`,
          `${snapshot}${suffix}`,
          constants.COPYFILE_FICLONE,
        );
      }
    }
    // SQLite can recover a hot rollback journal or rebuild its WAL index only
    // inside this disposable snapshot. The original directory is never opened.
    const sql = new DatabaseSync(snapshot, { timeout: 0 });
    try {
      const version = Number(
        sql.prepare("PRAGMA user_version").get()?.user_version,
      );
      sql.exec("PRAGMA query_only=ON");
      if (
        !Number.isSafeInteger(version) ||
        version < 0 ||
        version > metadataSchemaVersion
      )
        throw new RuntimeCompatibilityError("数据库版本不受支持");
      if (version === 0) {
        if (
          sql
            .prepare(
              "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .all().length
        )
          throw new RuntimeCompatibilityError("无法识别已有数据库");
      } else {
        const migrations = sql
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all();
        if (
          migrations.length !== version ||
          migrations.some((migration, index) => migration.version !== index + 1)
        )
          throw new RuntimeCompatibilityError("数据库迁移记录不完整");
      }
    } finally {
      sql.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function inspectDocumentVersion(
  path: string,
  field: string,
  supported: number,
  backup?: string,
): void {
  let document: unknown;
  try {
    document = readJson(path);
  } catch (error) {
    // Preserve the plugin manager's existing verified-backup recovery path.
    if (!backup) throw error;
    document = readJson(backup);
    if (document === undefined) throw error;
  }
  if (document === undefined) return;
  if (!object(document) || document[field] !== supported)
    throw new RuntimeCompatibilityError("偏好或插件安装记录版本不受支持");
}

/** Must run while the caller holds this business directory's runtime lock. */
export function prepareRuntimeCompatibility(
  directory: string,
  pluginDirectoryName: "plugins" | "plugins-development",
): void {
  try {
    const path = join(directory, compatibilityFileName);
    const previous = supportedDeclaration(readJson(path));
    inspectDatabase(directory);
    inspectDocumentVersion(
      join(directory, "preferences.json"),
      "schemaVersion",
      1,
    );
    const state = join(directory, pluginDirectoryName, "installed.json");
    inspectDocumentVersion(
      state,
      "schema",
      pluginProtocolVersions.state,
      `${state}.previous`,
    );
    const next: Declaration = {
      schemaVersion: 1,
      requirements: requirementsForThisRuntime(),
    };
    if (
      previous &&
      (
        [
          "engineProtocol",
          "metadataSchemaVersion",
          "pluginProtocol",
          "pluginSdk",
          "automationProtocol",
        ] as const
      ).every((key) => previous.requirements[key] === next.requirements[key]) &&
      JSON.stringify(
        [...new Set(previous.requirements.capabilities)].sort(),
      ) === JSON.stringify(next.requirements.capabilities)
    )
      return;
    // Persist requirements before any new-version business mutation can occur.
    const temporary = join(
      directory,
      `.${compatibilityFileName}.${randomUUID()}.tmp`,
    );
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      if (process.platform !== "win32") {
        const parent = openSync(directory, "r");
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (error) {
    if (error instanceof RuntimeCompatibilityError) throw error;
    throw new RuntimeCompatibilityError("无法完成数据兼容检查");
  }
}
