import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  definePlatformModule,
  type PlatformModule,
  type PlatformPluginEntry,
  type PlatformPluginExecution,
} from "@nedia-matrix/platform-sdk";
import type {
  PlatformPluginChange,
  PlatformPluginSummary,
} from "../../bridge/plugins.js";
import {
  maxPluginBytes,
  pluginIconUrl,
  verifyInstalledPlugin,
  verifyPluginArchive,
  type VerifiedPlugin,
} from "./plugin-package.js";

interface PackageRecord {
  id: string;
  platformId: string;
  displayName: string;
  version: string | null;
  slot: string | null;
  digest: string | null;
  enabled: boolean;
  pending?: {
    action: "install" | "enable" | "disable" | "remove";
    slot?: string;
  };
  error?: string;
}
interface PluginState {
  schema: 1;
  initialized: boolean;
  initializationError?: string;
  records: PackageRecord[];
}
const uuid = /^[a-f0-9-]{36}$/;
export class PlatformPluginManager {
  private state: PluginState;
  private readonly active = new Map<
    string,
    {
      module: PlatformModule;
      execution?: PlatformPluginExecution;
      directory: string;
    }
  >();
  private readonly errors = new Map<string, string>();
  private readonly icons = new Map<string, string>();
  constructor(
    private readonly root: string,
    private readonly keys: Readonly<Record<string, string>>,
  ) {
    mkdirSync(join(root, "packages"), { recursive: true });
    if (
      lstatSync(root).isSymbolicLink() ||
      lstatSync(join(root, "packages")).isSymbolicLink()
    )
      throw new Error("插件根目录不能为链接");
    if (existsSync(this.statePath())) {
      try {
        this.state = this.readState();
      } catch {
        const backup = this.statePath() + ".previous";
        if (!existsSync(backup))
          throw new Error("插件安装记录损坏，无法读取已验证的备份");
        this.state = this.readState(backup);
        if (!this.state.initialized)
          throw new Error("插件安装记录损坏，初始化备份不可用于自动预装");
        for (const record of this.state.records)
          record.error = "插件安装记录损坏，已恢复上次记录，请核对安装状态";
      }
    } else this.state = { schema: 1, initialized: false, records: [] };
  }
  private statePath() {
    return join(this.root, "installed.json");
  }
  private slotPath(slot: string) {
    if (!uuid.test(slot)) throw new Error("插件安装标识无效");
    return join(this.root, "packages", slot);
  }
  private readState(path = this.statePath()): PluginState {
    if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1024 * 1024)
      throw new Error("插件安装记录无效");
    const state = JSON.parse(readFileSync(path, "utf8")) as PluginState;
    const ids = new Set<string>(),
      platforms = new Set<string>();
    if (
      state.schema !== 1 ||
      typeof state.initialized !== "boolean" ||
      (state.initializationError !== undefined &&
        typeof state.initializationError !== "string") ||
      !Array.isArray(state.records)
    )
      throw new Error("插件安装记录损坏");
    for (const record of state.records) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(record.platformId) ||
        record.id !== `platform.${record.platformId}` ||
        ids.has(record.id) ||
        platforms.has(record.platformId) ||
        typeof record.displayName !== "string" ||
        typeof record.enabled !== "boolean" ||
        (record.slot !== null && !uuid.test(record.slot)) ||
        (record.version !== null && typeof record.version !== "string") ||
        (record.digest !== null && !/^[a-f0-9]{64}$/.test(record.digest)) ||
        (record.pending &&
          (!["install", "enable", "disable", "remove"].includes(
            record.pending.action,
          ) ||
            (record.pending.action === "install" &&
              (!record.pending.slot || !uuid.test(record.pending.slot)))))
      )
        throw new Error("插件安装记录损坏");
      ids.add(record.id);
      platforms.add(record.platformId);
    }
    return state;
  }
  private save(next: PluginState) {
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      const backupTemporary = temporary + ".previous";
      try {
        writeFileSync(backupTemporary, JSON.stringify(this.state) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        renameSync(backupTemporary, this.statePath() + ".previous");
      } finally {
        rmSync(backupTemporary, { force: true });
      }
      renameSync(temporary, this.statePath());
      this.state = next;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  private materialize(plugin: VerifiedPlugin): string {
    const slot = randomUUID(),
      directory = this.slotPath(slot);
    mkdirSync(directory);
    try {
      for (const [path, bytes] of plugin.files) {
        const target = join(directory, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      }
      writeFileSync(join(directory, "manifest.json"), plugin.archive.manifest, {
        flag: "wx",
      });
      writeFileSync(
        join(directory, "manifest.sig"),
        JSON.stringify(plugin.archive.signature),
        { flag: "wx" },
      );
      verifyInstalledPlugin(directory, this.keys);
      return slot;
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  stageInstall(bytes: Uint8Array): PlatformPluginSummary[] {
    const verified = verifyPluginArchive(bytes, this.keys),
      m = verified.manifest;
    const old = this.state.records.find((r) => r.platformId === m.platformId);
    if (
      old?.digest === verified.digest &&
      old.slot &&
      !old.pending &&
      !old.error &&
      !this.errors.has(old.id)
    ) {
      // Verify before treating a repair attempt as an idempotent install.
      try {
        verifyInstalledPlugin(this.slotPath(old.slot), this.keys);
        return this.list();
      } catch {
        /* repair below */
      }
    }
    const slot = this.materialize(verified);
    const record: PackageRecord = old
      ? {
          ...old,
          enabled: old.slot ? old.enabled : true,
          pending: { action: "install", slot },
          error: undefined,
        }
      : {
          id: m.id,
          platformId: m.platformId,
          displayName: m.displayName,
          version: null,
          digest: null,
          slot: null,
          enabled: true,
          pending: { action: "install", slot },
        };
    try {
      this.save({
        ...this.state,
        initializationError: undefined,
        records: [...this.state.records.filter((r) => r.id !== m.id), record],
      });
    } catch (error) {
      rmSync(this.slotPath(slot), { recursive: true, force: true });
      throw error;
    }
    return this.list();
  }
  stageChange(change: PlatformPluginChange): PlatformPluginSummary[] {
    if (!change || !["enable", "disable", "remove"].includes(change.action))
      throw new Error("插件操作无效");
    const record = this.state.records.find((r) => r.id === change.id);
    if (!record || (!record.slot && record.pending?.action !== "install"))
      throw new Error("插件未安装");
    if (record.pending?.action === "install" && change.action !== "remove")
      throw new Error("请先重启完成插件安装");
    this.save({
      ...this.state,
      records: this.state.records.map((r) =>
        r.id === change.id ? { ...r, pending: { action: change.action } } : r,
      ),
    });
    return this.list();
  }
  /** Called before any execution entry is imported. First preinstall is all-or-nothing. */
  preinstall(directory: string) {
    if (this.state.initialized) return;
    const packages = this.bundled(directory).map((bytes) =>
      verifyPluginArchive(bytes, this.keys),
    );
    const platforms = new Set<string>();
    for (const plugin of packages) {
      if (platforms.has(plugin.manifest.platformId))
        throw new Error("预装插件平台重复");
      platforms.add(plugin.manifest.platformId);
    }
    const records: PackageRecord[] = [];
    const created: string[] = [];
    try {
      for (const plugin of packages) {
        const slot = this.materialize(plugin);
        created.push(slot);
        const m = plugin.manifest;
        records.push({
          id: m.id,
          platformId: m.platformId,
          displayName: m.displayName,
          version: m.version,
          slot,
          digest: plugin.digest,
          enabled: true,
        });
      }
      this.save({ schema: 1, initialized: true, records });
    } catch (error) {
      for (const slot of created)
        rmSync(this.slotPath(slot), { force: true, recursive: true });
      throw error;
    }
  }
  reportPreinstallFailure() {
    if (this.state.initialized) return;
    this.save({
      schema: 1,
      initialized: true,
      initializationError: "预装插件校验或安装失败，请手动安装可信插件包",
      records: [],
    });
  }
  initializationError(): string | undefined {
    return this.state.initializationError;
  }
  private bundled(directory: string): Buffer[] {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".nmp"))
      .sort()
      .map((name) => {
        const path = join(directory, name),
          info = lstatSync(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size > maxPluginBytes
        )
          throw new Error("预装插件文件无效");
        return readFileSync(path);
      });
  }
  /** Stage bundled bytes for an authorized application update or an unpackaged development startup. */
  stageBundledUpdate(directory: string) {
    const packages = this.bundled(directory).map((bytes) =>
      verifyPluginArchive(bytes, this.keys),
    );
    // Validate all packages before recording any replacement intent.
    const records = structuredClone(this.state.records),
      created: string[] = [];
    try {
      for (const plugin of packages) {
        const record = records.find((r) => r.id === plugin.manifest.id);
        if (!record?.slot || record.pending) continue;
        if (record.digest === plugin.digest && !record.error) {
          try {
            verifyInstalledPlugin(this.slotPath(record.slot), this.keys);
            continue;
          } catch {
            // An identical rebuilt package can repair damaged installed bytes.
          }
        }
        const slot = this.materialize(plugin);
        created.push(slot);
        record.pending = { action: "install", slot };
      }
      if (created.length) this.save({ ...this.state, records });
    } catch (error) {
      for (const slot of created)
        rmSync(this.slotPath(slot), { recursive: true, force: true });
      throw error;
    }
  }
  reportUpdateFailure() {
    this.save({
      ...this.state,
      records: this.state.records.map((record) =>
        record.slot
          ? {
              ...record,
              error: "随软件更新插件失败，原安装已保留，请手动安装兼容插件",
            }
          : record,
      ),
    });
  }
  async load(): Promise<PlatformModule[]> {
    // Persist the new pointer before deleting old bytes. A crash always leaves a complete selected package.
    const next = structuredClone(this.state);
    for (const record of next.records) {
      const pending = record.pending;
      if (!pending) continue;
      delete record.pending;
      delete record.error;
      try {
        if (pending.action === "install") {
          const verified = verifyInstalledPlugin(
            this.slotPath(pending.slot!),
            this.keys,
          );
          if (verified.manifest.id !== record.id)
            throw new Error("插件身份不一致");
          record.slot = pending.slot!;
          record.version = verified.manifest.version;
          record.digest = verified.digest;
          record.displayName = verified.manifest.displayName;
        } else if (pending.action === "remove") {
          record.slot = null;
          record.version = null;
          record.digest = null;
          record.enabled = false;
        } else record.enabled = pending.action === "enable";
      } catch {
        record.error = "插件变更校验失败，原安装已保留，请重新安装";
      }
    }
    this.save(next);
    this.active.clear();
    this.errors.clear();
    this.icons.clear();
    for (const record of this.state.records) {
      if (!record.slot) continue;
      try {
        const directory = this.slotPath(record.slot),
          verified = verifyInstalledPlugin(directory, this.keys);
        if (
          verified.digest !== record.digest ||
          verified.manifest.id !== record.id
        )
          throw new Error("插件摘要不一致");
        const iconUrl = pluginIconUrl(verified);
        if (iconUrl) this.icons.set(record.platformId, iconUrl);
        if (!record.enabled) continue;
        const entry = (await import(
          /* @vite-ignore */ pathToFileURL(
            join(directory, verified.manifest.entry),
          ).href
        )) as { plugin: PlatformPluginEntry };
        if (
          !entry.plugin?.module ||
          entry.plugin.module.id !== record.platformId
        )
          throw new Error("插件导出身份不一致");
        const loadedModule = entry.plugin.module;
        if (
          (loadedModule.accountProfile &&
            typeof loadedModule.accountProfile.read !== "function") ||
          (loadedModule.content &&
            typeof loadedModule.content.read !== "function") ||
          (loadedModule.publishing &&
            (loadedModule.publishing.executionMode === "publisher"
              ? typeof entry.plugin.execution?.openPublisher !== "function"
              : typeof loadedModule.publishing.createResultMonitor !==
                "function"))
        )
          throw new Error("插件声明的执行能力缺少工厂");
        const source = {
          pluginId: record.id,
          pluginVersion: verified.manifest.version,
          packageDigest: verified.digest,
        };
        const module: PlatformModule = definePlatformModule({
          ...entry.plugin.module,
          iconUrl,
          pluginSource: source,
        });
        this.active.set(record.platformId, {
          module,
          execution: entry.plugin.execution,
          directory,
        });
      } catch (error) {
        console.error("平台插件加载失败", record.id, error);
        this.errors.set(
          record.id,
          "插件校验、协议兼容或加载失败，请重新安装兼容插件",
        );
      }
    }
    // Only current pointers remain. Orphaned staging and former packages are transaction residue, not history.
    const keep = new Set(
      this.state.records.flatMap((r) => (r.slot ? [r.slot] : [])),
    );
    for (const slot of readdirSync(join(this.root, "packages"))) {
      if (uuid.test(slot) && !keep.has(slot)) {
        try {
          rmSync(this.slotPath(slot), { recursive: true, force: true });
        } catch (error) {
          console.warn("插件事务残留清理失败，将在下次启动重试", error);
        }
      }
    }
    // Recovery snapshot mirrors the committed selection after transaction cleanup, never references old package bytes.
    try {
      const backupTemporary = join(this.root, `${randomUUID()}.backup.tmp`);
      try {
        writeFileSync(backupTemporary, JSON.stringify(this.state) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        renameSync(backupTemporary, this.statePath() + ".previous");
      } finally {
        rmSync(backupTemporary, { force: true });
      }
    } catch {
      /* The primary committed record remains authoritative. */
    }
    return [...this.active.values()].map((v) => v.module);
  }
  execution(platformId: string) {
    return this.active.get(platformId);
  }
  list(): PlatformPluginSummary[] {
    return this.state.records.map((r) => ({
      id: r.id,
      iconUrl: this.icons.get(r.platformId),
      platformId: r.platformId,
      displayName: r.displayName,
      version: r.version,
      enabled: r.enabled,
      installed: !!r.slot,
      available: this.active.has(r.platformId),
      error: this.errors.get(r.id) ?? r.error ?? null,
      pending: r.pending?.action ?? null,
    }));
  }
}
