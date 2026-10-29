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
  statfs,
  writeFile,
  open,
  rename,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { UpdateArtifact } from "./update-manifest.js";
import { isNewerVersion } from "./application-update.js";
import { APPLICATION_ID } from "../../bridge/update-source.js";

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
    parentPid: process.pid,
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
    await writeFile(
      join(directory, completed ? "success" : "migration-started"),
      request.id,
      { mode: 0o600 },
    );
  }
  if (completed && trashItem) {
    if (
      (context.platform === "darwin" && context.distribution === "app-zip") ||
      (context.platform === "win32" && context.distribution === "portable")
    )
      await recycleApplicationBackups(context, target, trashItem);
    if (
      context.platform === "win32" &&
      ["portable", "nsis"].includes(context.distribution)
    )
      await recycleWindowsUpdateFiles(context, target, trashItem);
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

/** Recycle only updater-owned Windows payloads at or below the running version. */
async function recycleWindowsUpdateFiles(
  context: InstallContext,
  target: string,
  trashItem: (file: string) => Promise<void>,
): Promise<void> {
  const root = join(context.userData, "application-updates");
  try {
    if ((await realpath(root)) !== root) return;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match =
        /^([0-9a-f]{64})-com\.nediamatrix\.desktop-(\d+\.\d+\.\d+)-win32-(x64)-(nsis|portable)-([0-9a-f]{64})$/.exec(
          entry.name,
        );
      const version = match?.[2];
      if (
        !match ||
        !version ||
        match[3] !== context.arch ||
        match[4] !== context.distribution ||
        (version !== context.currentVersion &&
          !isNewerVersion(context.currentVersion, version))
      )
        continue;
      await recycleOwnedPath(join(root, entry.name), true, trashItem);
    }
    if (context.distribution !== "nsis") return;
    const installations = join(root, "installations");
    if ((await realpath(installations)) !== installations) return;
    const records = await readdir(installations, { withFileTypes: true });
    for (const entry of records) {
      if (
        !entry.isDirectory() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          entry.name,
        )
      )
        continue;
      const directory = join(installations, entry.name);
      if ((await realpath(directory)) !== directory) continue;
      try {
        const bytes = await readFile(join(directory, "journal.json"), "utf8");
        if (bytes.length > 32_768) continue;
        const journal = JSON.parse(bytes);
        const request = journal.request as InstallRequest | undefined;
        if (
          !request ||
          request.id !== entry.name ||
          request.appId !== APPLICATION_ID ||
          request.platform !== "win32" ||
          request.distribution !== "nsis" ||
          request.target !== target ||
          request.arch !== context.arch ||
          (request.version !== context.currentVersion &&
            !isNewerVersion(context.currentVersion, request.version)) ||
          ![
            "completed",
            "installer-starting",
            "failed:installer-starting",
          ].includes(journal.stage) ||
          (await readFile(join(directory, "success"), "utf8")) !== request.id
        )
          continue;
        // Keep the helper, handshake markers and diagnostic records for recovery/audit.
        await recycleOwnedPath(join(directory, "setup.exe"), false, trashItem);
      } catch (error) {
        console.warn(
          "Windows installer cleanup could not inspect a record",
          directory,
          error,
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("Windows update payload cleanup failed", error);
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
