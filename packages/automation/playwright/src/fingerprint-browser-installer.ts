import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyFingerprintBrowser } from "./browser-runtime.js";

export const fingerprintBrowserVersion = "148.0.7778.215";
const base = `https://cdn.one-world.ai/browsers/${fingerprintBrowserVersion}`;
const assets: Record<string, { archive: string; binary: string }> = {
  "darwin-arm64": { archive: "macos-arm64.dmg", binary: "Chromium" },
  "linux-x64": { archive: "linux-x64.tar.xz", binary: "chrome" },
  "win32-x64": { archive: "windows-x64.zip", binary: "chrome.exe" },
};
export function fingerprintBrowserAsset(
  platform = process.platform,
  arch: string = process.arch,
) {
  return assets[`${platform}-${arch}`];
}
export type FingerprintInstallPhase =
  "downloading" | "checking" | "extracting" | "verifying" | "publishing";
export interface FingerprintInstallProgress {
  phase: FingerprintInstallPhase;
  receivedBytes: number;
  totalBytes?: number;
}
export type FingerprintInstallErrorCode =
  | "unsupported"
  | "network"
  | "checksum"
  | "archive"
  | "verification"
  | "filesystem"
  | "cleanup";
export class FingerprintInstallError extends Error {
  constructor(readonly code: FingerprintInstallErrorCode) {
    super(`Fingerprint browser installation failed: ${code}`);
  }
}
export interface FingerprintInstallerDependencies {
  fetch: typeof fetch;
  extract(
    archive: string,
    directory: string,
    temporary: string,
    platform: NodeJS.Platform,
    signal: AbortSignal,
  ): Promise<void>;
  verify: typeof verifyFingerprintBrowser;
  rename: typeof rename;
}
const defaults: FingerprintInstallerDependencies = {
  fetch: globalThis.fetch,
  extract: extractFingerprintArchive,
  verify: verifyFingerprintBrowser,
  rename,
};

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !!part && !isAbsolute(part) && !part.split(/[\\/]/).includes("..");
}

/** Paths and URLs never come from the Renderer. This is a trusted Main/CLI API. */
export async function readFingerprintInstallation(
  root: string,
  platform = process.platform,
  arch: string = process.arch,
): Promise<string | undefined> {
  const asset = fingerprintBrowserAsset(platform, arch);
  if (!asset) return undefined;
  try {
    const record = JSON.parse(
      await readFile(join(root, "installed.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      record.version !== fingerprintBrowserVersion ||
      record.asset !== asset.archive ||
      typeof record.executable !== "string" ||
      !isAbsolute(record.executable)
    )
      return undefined;
    const executable = await realpath(record.executable);
    if (
      !within(await realpath(root), executable) ||
      !(await lstat(executable)).isFile()
    )
      return undefined;
    await access(executable);
    return executable;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      ) ||
      error instanceof SyntaxError
    )
      return undefined;
    throw error;
  }
}

/** Only touches installer-owned staging/backup names inside the controlled root. */
export async function recoverFingerprintInstallation(
  root: string,
): Promise<void> {
  const parent = join(root, "..");
  await mkdir(parent, { recursive: true });
  const previous = `${root}.previous`;
  const entries = await readdir(parent);
  if (entries.includes(`${basename(root)}.previous`)) {
    // A final directory without a manifest is not a completed publish.
    let published = false;
    try {
      published = !!(await readFingerprintInstallation(root));
    } catch {
      /* Interrupted publication. */
    }
    if (published) await rm(previous, { recursive: true, force: true });
    else {
      await rm(root, { recursive: true, force: true });
      await rename(previous, root);
    }
  }
  for (const name of entries) {
    if (name.startsWith(`.${basename(root)}.staging-`)) {
      const temporary = join(parent, name);
      // Interrupted macOS mounts must be detached before deleting the mountpoint.
      if (process.platform === "darwin") {
        const mount = join(temporary, "mount");
        try {
          await lstat(mount);
          await detachFingerprintMount(mount);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new FingerprintInstallError("cleanup");
        }
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export async function installFingerprintBrowser(options: {
  root: string;
  signal?: AbortSignal;
  onProgress?(progress: FingerprintInstallProgress): void;
  platform?: NodeJS.Platform;
  arch?: string;
  dependencies?: Partial<FingerprintInstallerDependencies>;
}): Promise<string> {
  const { root } = options;
  if (!isAbsolute(root))
    throw new TypeError("Installation root must be absolute");
  const platform = options.platform ?? process.platform;
  const asset = fingerprintBrowserAsset(platform, options.arch ?? process.arch);
  if (!asset) throw new FingerprintInstallError("unsupported");
  const dependencies = { ...defaults, ...options.dependencies };
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  await mkdir(join(root, ".."), { recursive: true });
  const temporary = await mkdtemp(
    join(root, "..", `.${basename(root)}.staging-`),
  );
  const staged = join(temporary, "browser");
  let phase: FingerprintInstallPhase = "downloading";
  let receivedBytes = 0;
  let totalBytes: number | undefined;
  const progress = (next: FingerprintInstallPhase = phase) => {
    phase = next;
    try {
      options.onProgress?.({
        phase,
        receivedBytes,
        ...(totalBytes ? { totalBytes } : {}),
      });
    } catch {
      /* Observers do not own lifecycle. */
    }
  };
  try {
    progress();
    const checksumSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(30_000),
    ]);
    const checksums = await dependencies.fetch(`${base}/SHA256SUMS`, {
      redirect: "error",
      signal: checksumSignal,
    });
    if (!checksums.ok) {
      await checksums.body?.cancel().catch(() => undefined);
      throw new FingerprintInstallError("network");
    }
    const expected = (await checksums.text())
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((fields) => fields[1]?.replace(/^\*/, "") === asset.archive)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
      throw new FingerprintInstallError("checksum");
    const downloadSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(600_000),
    ]);
    const response = await dependencies.fetch(`${base}/${asset.archive}`, {
      redirect: "error",
      signal: downloadSignal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new FingerprintInstallError("network");
    }
    const length = Number(response.headers.get("content-length"));
    totalBytes =
      Number.isSafeInteger(length) && length > 0 ? length : undefined;
    const archive = join(temporary, asset.archive);
    const reader = response.body.getReader();
    const chunks = async function* () {
      try {
        for (;;) {
          downloadSignal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.length;
          progress();
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    };
    await pipeline(
      Readable.from(chunks()),
      createWriteStream(archive, { flags: "wx" }),
      { signal: downloadSignal },
    );
    signal.throwIfAborted();
    progress("checking");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest("hex") !== expected.toLowerCase())
      throw new FingerprintInstallError("checksum");
    progress("extracting");
    await mkdir(staged);
    await dependencies.extract(archive, staged, temporary, platform, signal);
    signal.throwIfAborted();
    await auditExtractedTree(staged);
    const binary = await findBinary(staged, asset.binary);
    if (!binary) throw new FingerprintInstallError("archive");
    progress("verifying");
    // Probe owns its browser processes; cancellation waits for its finally blocks.
    await dependencies.verify(binary, signal);
    signal.throwIfAborted();
    const executable = join(root, relative(staged, binary));
    await writeFile(
      join(staged, "installed.json"),
      JSON.stringify({
        version: fingerprintBrowserVersion,
        asset: asset.archive,
        executable,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    signal.throwIfAborted();
    progress("publishing");
    const previous = `${root}.previous`;
    let backedUp = false;
    try {
      await dependencies.rename(root, previous);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await dependencies.rename(staged, root);
    } catch (error) {
      if (backedUp) await dependencies.rename(previous, root);
      throw error;
    }
    if (backedUp) await rm(previous, { recursive: true, force: true });
    return executable;
  } catch (error) {
    if (error instanceof FingerprintInstallError && error.code === "cleanup")
      throw error;
    if (signal.aborted) throw signal.reason;
    if (error instanceof FingerprintInstallError) throw error;
    throw new FingerprintInstallError(
      phase === "downloading"
        ? "network"
        : phase === "extracting"
          ? "archive"
          : phase === "verifying"
            ? "verification"
            : "filesystem",
    );
  } finally {
    // If detach failed, retain the staging directory for startup recovery.
    let retainedMount = false;
    try {
      await lstat(join(temporary, "mount"));
      retainedMount = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new FingerprintInstallError("cleanup");
    }
    if (retainedMount) throw new FingerprintInstallError("cleanup");
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch {
      throw new FingerprintInstallError("cleanup");
    }
  }
}

async function findBinary(
  root: string,
  name: string,
): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findBinary(path, name);
      if (found) return found;
    }
  }
}
async function auditExtractedTree(
  root: string,
  directory = root,
): Promise<void> {
  const canonicalRoot = await realpath(root);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!within(canonicalRoot, await realpath(path)))
        throw new FingerprintInstallError("archive");
    } else if (entry.isDirectory()) await auditExtractedTree(root, path);
    else if (!entry.isFile()) throw new FingerprintInstallError("archive");
  }
}

export async function runFingerprintCommand(
  program: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let spawnError: Error | undefined;
    let termination: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => abort(), 120_000);
    let interrupted = false;
    const abort = () => {
      interrupted = true;
      child.kill();
      termination ??= setTimeout(() => child.kill("SIGKILL"), 3_000);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 8 * 1024 * 1024) abort();
    });
    child.stderr.resume(); // Never leak subprocess output (which can contain local paths).
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (termination) clearTimeout(termination);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (spawnError || interrupted || code !== 0)
        reject(new FingerprintInstallError("archive"));
      else resolve(output);
    });
    if (signal.aborted) abort();
  });
}

export async function extractFingerprintArchive(
  archive: string,
  directory: string,
  temporary: string,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<void> {
  if (platform === "darwin") {
    const mount = join(temporary, "mount");
    await mkdir(mount);
    try {
      await runFingerprintCommand(
        "hdiutil",
        ["attach", archive, "-readonly", "-nobrowse", "-mountpoint", mount],
        signal,
      );
      const apps = (await readdir(mount, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
      );
      if (apps.length !== 1) throw new FingerprintInstallError("archive");
      signal.throwIfAborted();
      await cp(join(mount, apps[0]!.name), join(directory, apps[0]!.name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    } finally {
      // Detach is mandatory even when attach/copy was interrupted. It cannot use
      // the aborted task signal, and cleanup failure must remain visible.
      try {
        await detachFingerprintMount(mount);
      } catch {
        throw new FingerprintInstallError("cleanup");
      }
      await rm(mount, { recursive: true, force: true });
    }
  } else if (platform === "linux") {
    const names = await runFingerprintCommand("tar", ["-tf", archive], signal);
    if (
      names
        .split(/\r?\n/)
        .some(
          (name) =>
            name.startsWith("/") ||
            name.includes("\\") ||
            name.split("/").includes(".."),
        )
    )
      throw new FingerprintInstallError("archive");
    const types = await runFingerprintCommand("tar", ["-tvf", archive], signal);
    // Reject links and special files before extraction; no entry may redirect a later write.
    if (
      types
        .split(/\r?\n/)
        .some((line) => line && !["-", "d"].includes(line[0]!))
    )
      throw new FingerprintInstallError("archive");
    await runFingerprintCommand(
      "tar",
      [
        "-xf",
        archive,
        "-C",
        directory,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      signal,
    );
  } else if (platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $root=[IO.Path]::GetFullPath(${quote(directory)})+[IO.Path]::DirectorySeparatorChar; $zip=[IO.Compression.ZipFile]::OpenRead(${quote(archive)}); try { foreach($entry in $zip.Entries) { $name=$entry.FullName; if($name -match '(^[/\\\\]|^[A-Za-z]:|(^|[/\\\\])\\.\\.([/\\\\]|$)|:)' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe archive'; }; $target=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$name)); if(!$target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive'; } } } finally { $zip.Dispose() }; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)},${quote(directory)});`;
    await runFingerprintCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      signal,
    );
  } else throw new FingerprintInstallError("unsupported");
}

async function detachFingerprintMount(mount: string): Promise<void> {
  const signal = new AbortController().signal;
  const xmlPath = (value: string) =>
    `<string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`;
  const info = await runFingerprintCommand(
    "hdiutil",
    ["info", "-plist"],
    signal,
  );
  const canonical = await realpath(mount);
  if (info.includes(xmlPath(mount)) || info.includes(xmlPath(canonical)))
    await runFingerprintCommand("hdiutil", ["detach", mount, "-quiet"], signal);
}
