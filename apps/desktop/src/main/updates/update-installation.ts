import { spawn } from "node:child_process";
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
import { dirname, extname, join, resolve } from "node:path";
import type { UpdateArtifact } from "./update-manifest.js";
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

/** Keep every backup. Only mark success after startup/migrations, never merely after launching. */
export async function recordUpdateStartup(
  context: InstallContext,
  completed: boolean,
): Promise<void> {
  if (!context.packaged) return;
  const root = join(context.userData, "application-updates", "installations");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;
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
    let journal: { request?: InstallRequest; stage?: string };
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
      ].includes(journal.stage ?? "")
    )
      continue;
    await writeFile(
      join(directory, completed ? "success" : "migration-started"),
      request.id,
      { mode: 0o600 },
    );
  }
}
