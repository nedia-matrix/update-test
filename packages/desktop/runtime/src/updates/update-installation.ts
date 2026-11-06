import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rmdir,
  statfs,
  writeFile,
  open,
  rename,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { UpdateArtifact } from "./update-manifest.js";
import { isNewerVersion } from "./application-update.js";
import { APPLICATION_ID } from "@nedia-matrix/desktop-contracts/update-source";

export interface InstallPackage {
  file: string;
  version: string;
  artifact: UpdateArtifact;
}
export interface InstallContext {
  packaged: boolean;
  platform: string;
  arch: string;
  distribution: string;
  executable: string;
  parentPid?: number;
  portableExecutable?: string;
  portableDirectory?: string;
  resources: string;
  userData: string;
  currentVersion: string;
  includePlugins?: boolean;
}
export interface InstallRequest {
  id: string;
  parentPid: number;
  platform: string;
  arch: string;
  distribution: string;
  version: string;
  currentVersion: string;
  appId: string;
  package: string;
  target: string;
  size: number;
  sha256: string;
}
export interface PreparedInstallation {
  commit(): Promise<void>;
  cancel(): Promise<void>;
}

export async function installationTarget(
  context: InstallContext,
): Promise<string> {
  if (!context.packaged)
    throw new Error("开发环境不允许安装更新，请使用打包应用");
  let target: string;
  if (context.platform === "darwin" && context.distribution === "app-zip") {
    target = resolve(dirname(context.executable), "../..");
    if (!target.endsWith(".app"))
      throw new Error("无法确定当前应用 bundle，请手动安装");
  } else if (
    context.platform === "win32" &&
    context.distribution === "portable"
  ) {
    if (!context.portableExecutable || !context.portableDirectory)
      throw new Error("无法确定绿色版原始 EXE 路径，请手动安装");
    target = context.portableExecutable;
    if (resolve(dirname(target)) !== resolve(context.portableDirectory))
      throw new Error("绿色版启动器路径不一致，请手动安装");
  } else if (context.platform === "win32" && context.distribution === "nsis") {
    target = context.executable;
  } else throw new Error("此发行类型不支持应用内安装，请手动安装");
  if (
    resolve(target) !== target ||
    (context.platform === "win32" && extname(target).toLowerCase() !== ".exe")
  )
    throw new Error("应用目标路径无效，请手动安装");
  const info = await lstat(target);
  if (
    info.isSymbolicLink() ||
    (context.platform === "darwin" ? !info.isDirectory() : !info.isFile())
  )
    throw new Error("应用目标类型无效，请手动安装");
  const canonical = await realpath(target);
  // Reject symlinked application paths rather than replacing their referents unexpectedly.
  if (context.platform === "darwin" && canonical !== target)
    throw new Error("应用位于链接路径，请手动安装");
  return canonical;
}

export async function prepareInstallation(
  context: InstallContext,
  update: InstallPackage,
): Promise<PreparedInstallation> {
  if (
    update.artifact.platform !== context.platform ||
    update.artifact.arch !== context.arch ||
    update.artifact.distribution !== context.distribution
  )
    throw new Error("更新包与运行应用不匹配");
  const target = await installationTarget(context);
  if (context.distribution !== "nsis")
    await access(dirname(target), constants.W_OK);
  const root = join(context.userData, "application-updates", "installations");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  for (const directory of context.distribution === "nsis"
    ? [canonicalRoot]
    : [dirname(target), canonicalRoot]) {
    const space = await statfs(directory);
    if (
      space.bavail * space.bsize <
      update.artifact.size * 6 + 256 * 1024 * 1024
    )
      throw new Error("安装暂存空间不足，请释放空间或手动安装");
  }
  const id = randomUUID();
  const directory = join(canonicalRoot, id);
  await mkdir(directory, { mode: 0o700 });
  const request: InstallRequest = {
    id,
    parentPid: context.parentPid ?? process.pid,
    platform: context.platform,
    arch: context.arch,
    distribution: context.distribution,
    appId: APPLICATION_ID,
    version: update.version,
    currentVersion: context.currentVersion,
    package: await realpath(update.file),
    target,
    size: update.artifact.size,
    sha256: update.artifact.sha256,
  };
  const helperName =
    context.platform === "win32"
      ? "nedia-update-helper.exe"
      : "nedia-update-helper";
  const source = join(context.resources, "update-helper", helperName);
  if (!(await lstat(source)).isFile())
    throw new Error("安装辅助程序缺失，请手动安装");
  const helper = join(directory, helperName);
  // No helper code is taken from the downloaded release.
  await copyFile(source, helper, constants.COPYFILE_EXCL);
  await writeFile(join(directory, "request.json"), JSON.stringify(request), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(directory, "plugin-choice.json"),
    JSON.stringify({ id, includePlugins: context.includePlugins === true }),
    { flag: "wx", mode: 0o600 },
  );
  const child = spawn(helper, [join(directory, "request.json")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.on("exit", (code) => {
    failure ??= new Error(
      `安装辅助程序提前退出（${code}），请查看 ${join(directory, "journal.json")}`,
    );
  });
  child.unref();
  const marker = async (name: string) =>
    (await readFile(join(directory, name), "utf8").catch(() => "")) === id;
  const cancel = async () => {
    await writeFile(join(directory, "cancel"), id, {
      flag: "wx",
      mode: 0o600,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  };
  try {
    const deadline = Date.now() + 120_000;
    while (!(await marker("ready"))) {
      const error = await readFile(join(directory, "error"), "utf8").catch(
        () => "",
      );
      if (error)
        throw new Error(`安装预检失败：${error}。可以打开文件位置手动安装。`);
      if (failure) throw failure;
      if (Date.now() > deadline)
        throw new Error("安装辅助程序准备超时，请手动安装");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await cancel();
    throw error;
  }
  return {
    cancel,
    commit: async () => {
      if (failure || (await marker("cancel")))
        throw failure ?? new Error("安装已取消");
      // The helper also waits for the old process to disappear before acting.
      const file = await open(join(directory, "commit.tmp"), "wx", 0o600);
      try {
        await file.writeFile(id);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(join(directory, "commit.tmp"), join(directory, "commit"));
      if (context.platform === "darwin") {
        const parent = await open(directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    },
  };
}

/** Only confirmed startup allows recycling an application backup. */
export async function recordUpdateStartup(
  context: InstallContext,
  completed: boolean,
  trashItem?: (file: string) => Promise<void>,
  stagePlugins?: () => void,
): Promise<void> {
  if (!context.packaged) return;
  const root = join(context.userData, "application-updates", "installations");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  // An unavailable updater target must not prevent normal/manual application startup.
  let target: string;
  try {
    target = await installationTarget(context);
  } catch {
    console.warn(
      "Update startup could not be correlated with the installed target; backups were retained",
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    const bytes = await readFile(join(directory, "journal.json"), "utf8").catch(
      () => "",
    );
    if (!bytes || bytes.length > 32_768) continue;
    let journal: { request?: InstallRequest; stage?: string; backup?: string };
    try {
      journal = JSON.parse(bytes);
    } catch {
      continue;
    }
    const request = journal.request;
    if (
      !request ||
      request.id !== entry.name ||
      request.appId !== APPLICATION_ID ||
      request.version !== context.currentVersion ||
      request.target !== target ||
      request.distribution !== context.distribution ||
      request.platform !== context.platform ||
      request.arch !== context.arch
    )
      continue;
    if (
      ![
        "launching",
        "installer-starting",
        "failed:launching",
        "failed:installer-starting",
        "completed",
      ].includes(journal.stage ?? "")
    )
      continue;
    if (
      journal.stage === "completed" &&
      (!completed ||
        (await readFile(join(directory, "success"), "utf8").catch(() => "")) !==
          request.id)
    )
      continue;
    if (
      !completed &&
      stagePlugins &&
      (await readFile(join(directory, "plugins-staged"), "utf8").catch(
        () => "",
      )) !== request.id
    ) {
      const choice = await readFile(
        join(directory, "plugin-choice.json"),
        "utf8",
      ).catch(() => "");
      if (choice) {
        let selected: { id?: string; includePlugins?: boolean } | undefined;
        try {
          selected = JSON.parse(choice);
        } catch {
          /* Invalid intent must never authorize plugin replacement. */
        }
        if (selected?.id === request.id && selected.includePlugins === true)
          stagePlugins();
      }
      await writeFile(join(directory, "plugins-staged"), request.id, {
        mode: 0o600,
      });
    }
    const marker = join(directory, completed ? "success" : "migration-started");
    // Preserve the original confirmation time for retention decisions.
    if ((await readFile(marker, "utf8").catch(() => "")) !== request.id)
      await writeFile(marker, request.id, { mode: 0o600 });
  }
  if (completed && trashItem) {
    if (
      (context.platform === "darwin" && context.distribution === "app-zip") ||
      (context.platform === "win32" && context.distribution === "portable")
    )
      await recycleApplicationBackups(context, target, trashItem);
    const key = join(context.userData, "application-updates");
    let cleanup = recycling.get(key);
    if (!cleanup) {
      cleanup = (async () => {
        await recycleUpdateFiles(context, trashItem);
        await recycleInstallationHistory(context, target, trashItem);
      })().finally(() => recycling.delete(key));
      recycling.set(key, cleanup);
    }
    await cleanup;
  }
}

const recycling = new Map<string, Promise<void>>();

async function recycleApplicationBackups(
  context: InstallContext,
  target: string,
  trashItem: (file: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(target);
  const prefix = `${basename(target)}.nedia-backup-`;
  const entries = await readdir(parent, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (
      (context.platform === "darwin"
        ? !entry.isDirectory()
        : !entry.isFile()) ||
      !entry.name.startsWith(prefix) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        entry.name.slice(prefix.length),
      )
    )
      continue;
    const backup = join(parent, entry.name);
    const active = recycling.get(backup);
    if (active) {
      await active;
      continue;
    }
    const operation = (async () => {
      try {
        const info = await lstat(backup);
        if (
          (context.platform === "darwin"
            ? !info.isDirectory()
            : !info.isFile()) ||
          info.isSymbolicLink() ||
          (await realpath(backup)) !== backup
        )
          return;
        if (context.platform === "darwin") {
          const plist = join(backup, "Contents", "Info.plist");
          const plistInfo = await lstat(plist);
          if (
            !plistInfo.isFile() ||
            plistInfo.isSymbolicLink() ||
            (await realpath(plist)) !== plist
          )
            return;
          // plutil supports both XML and binary property lists. No journal is needed.
          const appId = await new Promise<string>((resolve, reject) => {
            execFile(
              "/usr/bin/plutil",
              ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
              { encoding: "utf8", timeout: 5_000, maxBuffer: 16_384 },
              (error, stdout) =>
                error ? reject(error) : resolve(stdout.trim()),
            );
          });
          if (appId !== APPLICATION_ID) return;
        } else {
          // Run only the trusted helper bundled with the current application.
          await new Promise<void>((resolve, reject) => {
            execFile(
              join(
                context.resources,
                "update-helper",
                "nedia-update-helper.exe",
              ),
              ["--verify-portable-backup", backup],
              { windowsHide: true, timeout: 5_000, maxBuffer: 16_384 },
              (error) => (error ? reject(error) : resolve()),
            );
          });
        }
        await trashItem(backup);
        if (
          await lstat(backup).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          })
        )
          throw new Error("回收站操作后旧备份仍在原位置，等待下次启动重试");
      } catch (error) {
        // A cleanup failure must not prevent startup; the next healthy startup retries.
        console.warn("Application backup could not be recycled", backup, error);
      }
    })().finally(() => recycling.delete(backup));
    recycling.set(backup, operation);
    await operation;
  }
}

const DAY = 24 * 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function processMayBeAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return true;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function pathMayExist(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function ownedDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  return (
    !!info?.isDirectory() &&
    !info.isSymbolicLink() &&
    (await realpath(path)) === path
  );
}

interface InstallationRecord {
  directory: string;
  request: InstallRequest;
  stage: string;
  helperPid?: number;
  modified: number;
  confirmed: boolean;
}

async function installationRecords(
  context: InstallContext,
): Promise<InstallationRecord[]> {
  const root = join(context.userData, "application-updates");
  const installations = join(root, "installations");
  if (!(await ownedDirectory(root)) || !(await ownedDirectory(installations)))
    return [];
  const records: InstallationRecord[] = [];
  for (const entry of await readdir(installations, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const directory = join(installations, entry.name);
    try {
      if (!(await ownedDirectory(directory))) continue;
      const file = join(directory, "journal.json");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768)
        continue;
      const journal = JSON.parse(await readFile(file, "utf8"));
      const request = journal.request as InstallRequest | undefined;
      if (
        !request ||
        request.id !== entry.name ||
        request.appId !== APPLICATION_ID
      )
        continue;
      records.push({
        directory,
        request,
        stage: journal.stage,
        helperPid: journal.helperPid,
        modified: info.mtimeMs,
        confirmed:
          (await readFile(join(directory, "success"), "utf8").catch(
            () => "",
          )) === request.id,
      });
    } catch (error) {
      console.warn(
        "Update cleanup could not inspect a record",
        directory,
        error,
      );
    }
  }
  return records;
}

// A helper can still be validating a request before it publishes its first journal.
async function protectedInstallationCaches(
  context: InstallContext,
): Promise<Set<string>> {
  const records = await installationRecords(context);
  const byDirectory = new Map(
    records.map((record) => [record.directory, record]),
  );
  const protectedCaches = new Set<string>();
  const installations = join(
    context.userData,
    "application-updates",
    "installations",
  );
  if (!(await ownedDirectory(installations))) return protectedCaches;
  for (const entry of await readdir(installations, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const directory = join(installations, entry.name);
    if (!(await ownedDirectory(directory))) continue;
    const record = byDirectory.get(directory);
    if (
      record?.confirmed &&
      record.stage === "completed" &&
      (record.helperPid === undefined || !processMayBeAlive(record.helperPid))
    )
      continue;
    let request = record?.request;
    if (!request) {
      try {
        const file = join(directory, "request.json");
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
          continue;
        request = JSON.parse(await readFile(file, "utf8"));
      } catch {
        continue;
      }
    }
    if (
      request?.id === entry.name &&
      request.appId === APPLICATION_ID &&
      typeof request.package === "string"
    )
      protectedCaches.add(dirname(request.package));
  }
  return protectedCaches;
}

/** Recycle scoped downloads; incomplete installation requests protect their packages. */
async function recycleUpdateFiles(
  context: InstallContext,
  trashItem: (file: string) => Promise<void>,
): Promise<void> {
  const root = join(context.userData, "application-updates");
  try {
    if (!(await ownedDirectory(root))) return;
    const protectedCaches = await protectedInstallationCaches(context);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match =
        /^([0-9a-f]{64})-com\.nediamatrix\.desktop-(\d+\.\d+\.\d+)-(darwin|win32)-(arm64|x64)-(app-zip|nsis|portable)-([0-9a-f]{64})$/.exec(
          entry.name,
        );
      if (
        !match ||
        match[3] !== context.platform ||
        match[4] !== context.arch ||
        match[5] !== context.distribution
      )
        continue;
      const directory = join(root, entry.name);
      if (protectedCaches.has(directory) || !(await ownedDirectory(directory)))
        continue;
      const version = match[2]!;
      if (
        version === context.currentVersion ||
        isNewerVersion(context.currentVersion, version)
      ) {
        await recycleOwnedPath(directory, true, trashItem);
        continue;
      }
      // Future downloads stay available; only abandoned partial files expire.
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (
          !file.isFile() ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.[0-9a-f-]{36}\.part$/.test(
            file.name,
          )
        )
          continue;
        const path = join(directory, file.name);
        if (Date.now() - (await lstat(path)).mtimeMs >= 7 * DAY)
          await recycleOwnedPath(path, false, trashItem);
      }
      const info = await lstat(directory);
      if (Date.now() - info.mtimeMs >= 7 * DAY)
        // rmdir is intentionally nonrecursive: a concurrent download must survive.
        await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? ""))
            throw error;
        });
    }
  } catch (error) {
    console.warn("Update payload cleanup failed", error);
  }
}

async function recycleInstallationHistory(
  context: InstallContext,
  target: string,
  trashItem: (file: string) => Promise<void>,
): Promise<void> {
  try {
    const records = (await installationRecords(context)).filter(
      ({ request }) =>
        request.target === target &&
        request.platform === context.platform &&
        request.arch === context.arch &&
        request.distribution === context.distribution &&
        (request.version === context.currentVersion ||
          isNewerVersion(context.currentVersion, request.version)),
    );
    const completed = records
      .filter((record) => record.stage === "completed" && record.confirmed)
      .sort((a, b) => b.modified - a.modified);
    for (const record of records) {
      const { request, directory, stage, helperPid, confirmed } = record;
      const age = Date.now() - record.modified;
      if (helperPid !== undefined && processMayBeAlive(helperPid)) continue;
      const successful =
        confirmed &&
        [
          "completed",
          "installer-starting",
          "failed:installer-starting",
        ].includes(stage);
      if (successful) {
        if (context.distribution === "nsis") {
          await recycleOwnedPath(
            join(directory, "setup.exe"),
            false,
            trashItem,
          );
          if (await pathMayExist(join(directory, "setup.exe"))) continue;
        }
        if (stage !== "completed") continue;
        // A terminal journal is published only after helper use of extracted files ends.
        if (context.distribution === "app-zip") {
          await recycleOwnedPath(join(directory, "extracted"), true, trashItem);
          if (await pathMayExist(join(directory, "extracted"))) continue;
        }
        // Keep at most five successful records for up to 30 days, with a 24h grace period.
        if (age < DAY || (completed.indexOf(record) < 5 && age < 30 * DAY))
          continue;
      } else {
        // Legacy failed records without a helper PID remain available for manual recovery.
        if (
          !["failed:preparing", "failed:waiting-exit"].includes(stage) ||
          age < 7 * DAY ||
          helperPid === undefined ||
          processMayBeAlive(request.parentPid) ||
          (await pathMayExist(join(directory, "migration-started")))
        )
          continue;
      }
      const backup = `${target}.nedia-backup-${request.id}`;
      const staged =
        context.distribution === "nsis"
          ? join(directory, "setup.exe")
          : `${target}.nedia-stage-${request.id}${context.platform === "win32" ? ".exe" : ""}`;
      // Never remove recovery records while a backup or conflicting staged copy remains.
      if (await pathMayExist(backup)) continue;
      if (!successful)
        await recycleOwnedPath(
          staged,
          context.platform === "darwin",
          trashItem,
        );
      if (await pathMayExist(staged)) continue;
      await recycleOwnedPath(directory, true, trashItem);
    }
  } catch (error) {
    console.warn("Update installation history cleanup failed", error);
  }
}

async function recycleOwnedPath(
  path: string,
  directory: boolean,
  trashItem: (file: string) => Promise<void>,
): Promise<void> {
  const active = recycling.get(path);
  if (active) return active;
  const operation = (async () => {
    try {
      const info = await lstat(path);
      if (
        info.isSymbolicLink() ||
        (directory ? !info.isDirectory() : !info.isFile()) ||
        (await realpath(path)) !== path
      )
        return;
      await trashItem(path);
      if (
        await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })
      )
        throw new Error(
          "Update payload remains after recycling; retry on next startup",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn("Update payload could not be recycled", path, error);
    }
  })().finally(() => recycling.delete(path));
  recycling.set(path, operation);
  return operation;
}
