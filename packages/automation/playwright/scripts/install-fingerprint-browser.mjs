import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyFingerprintBrowser } from "../dist/index.js";

// Matches the locally reviewed xiaohongshu-mcp browser_version.txt; upgrades are explicit.
const version = "148.0.7778.215";
const base = `https://cdn.one-world.ai/browsers/${version}`;
const platforms = {
  "darwin-arm64": ["macos-arm64.dmg", "Chromium"],
  "linux-x64": ["linux-x64.tar.xz", "chrome"],
  "win32-x64": ["windows-x64.zip", "chrome.exe"],
};
const asset = platforms[`${process.platform}-${process.arch}`];
if (!asset)
  throw new Error(
    `No reviewed fingerprint browser for ${process.platform}/${process.arch}`,
  );
const cacheRoot =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Caches")
    : process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? tmpdir())
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
const cache = join(cacheRoot, "nedia-matrix", "browsers", version);

async function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "",
      error = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      error += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${program} failed (${code}): ${error}`)),
    );
  });
}
async function findBinary(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === asset[1]) return path;
    if (entry.isDirectory()) {
      const found = await findBinary(path);
      if (found) return found;
    }
  }
}

await mkdir(cache, { recursive: true });
let executable = await findBinary(cache);
if (!executable) {
  const temporary = await mkdtemp(join(tmpdir(), "nedia-browser-download-"));
  try {
    console.log(`Downloading fingerprint Chromium ${version} (${asset[0]})…`);
    const checksums = await fetch(`${base}/SHA256SUMS`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!checksums.ok)
      throw new Error(`Checksum request failed: HTTP ${checksums.status}`);
    const expected = (await checksums.text())
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((fields) => fields[1]?.replace(/^\*/, "") === asset[0])?.[0];
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
      throw new Error("Missing browser SHA256");
    const response = await fetch(`${base}/${asset[0]}`, {
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Browser download failed: HTTP ${response.status}`);
    const archive = join(temporary, asset[0]);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(archive, { flags: "wx" }),
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== expected.toLowerCase())
      throw new Error("Browser SHA256 mismatch");
    if (process.platform === "darwin") {
      const mount = join(temporary, "mount");
      await mkdir(mount);
      await command("hdiutil", [
        "attach",
        archive,
        "-nobrowse",
        "-mountpoint",
        mount,
      ]);
      try {
        const app = (await readdir(mount)).find((name) =>
          name.endsWith(".app"),
        );
        if (!app) throw new Error("Browser DMG has no app bundle");
        await cp(join(mount, app), join(cache, app), { recursive: true });
      } finally {
        await command("hdiutil", ["detach", mount, "-quiet"]);
      }
    } else if (process.platform === "linux") {
      const entries = await command("tar", ["-tf", archive]);
      if (
        entries
          .split(/\r?\n/)
          .some(
            (name) => name.startsWith("/") || name.split("/").includes(".."),
          )
      )
        throw new Error("Unsafe archive path");
      await command("tar", ["-xf", archive, "-C", cache]);
    } else {
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      await command("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(cache)} -Force`,
      ]);
    }
    executable = await findBinary(cache);
    if (!executable)
      throw new Error("Browser executable missing after extraction");
  } catch (error) {
    await rm(cache, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
await access(executable);
console.log("Verifying native fingerprint capability…");
await verifyFingerprintBrowser(executable);
await writeFile(
  join(cache, "installed.json"),
  JSON.stringify({ version, asset: asset[0], executable }, null, 2) + "\n",
);
console.log(`Verified: ${executable}`);
console.log(
  process.platform === "win32"
    ? `$env:NEDIA_FINGERPRINT_BROWSER_PATH = '${executable.replaceAll("'", "''")}'; pnpm dev`
    : `NEDIA_FINGERPRINT_BROWSER_PATH='${executable.replaceAll("'", "'\\''")}' pnpm dev`,
);
