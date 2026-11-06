import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const arch = process.argv[2] ?? process.env.NEDIA_TARGET_ARCH ?? process.arch;
const platform = process.env.NEDIA_TARGET_PLATFORM ?? process.platform;
if (
  platform !== process.platform &&
  !(platform === "win32" && arch === "x64" && process.platform === "darwin")
)
  throw new Error("Unsupported runtime lock cross-compilation target");
if (!["arm64", "x64"].includes(arch))
  throw new Error("Unsupported runtime lock architecture");
const desktop = resolve(import.meta.dirname, "../../apps/desktop");
let headers =
  process.env.NEDIA_NODE_HEADERS ??
  join(
    homedir(),
    process.platform === "darwin"
      ? "Library/Caches/node-gyp"
      : ".cache/node-gyp",
    process.versions.node,
    "include/node",
  );
const version = process.versions.node;
const cache = resolve(desktop, "../../.local/native-node", version);
function fetchOfficial(name, output) {
  mkdirSync(cache, { recursive: true });
  const download = (url, file) => {
    const result = spawnSync(
      "curl",
      ["--fail", "--location", "--retry", "2", url, "-o", file],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error("Node native build input download failed");
  };
  const base = `https://nodejs.org/dist/v${version}`;
  download(`${base}/${name}`, output);
  const sums = join(cache, "SHASUMS256.txt");
  download(`${base}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${name}`))
    ?.split(" ")[0];
  if (
    !expected ||
    createHash("sha256").update(readFileSync(output)).digest("hex") !== expected
  )
    throw new Error("Node native build input checksum mismatch");
}
if (!existsSync(join(headers, "node_api.h"))) {
  if (process.env.NEDIA_NODE_HEADERS)
    throw new Error("Invalid NEDIA_NODE_HEADERS");
  headers = join(cache, `node-v${version}`, "include/node");
  if (!existsSync(join(headers, "node_api.h"))) {
    const archive = join(cache, `node-v${version}-headers.tar.gz`);
    fetchOfficial(`node-v${version}-headers.tar.gz`, archive);
    const result = spawnSync("tar", ["-xzf", archive, "-C", cache], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Node headers extraction failed");
  }
}
const output = join(desktop, "resources/native", `${platform}-${arch}`);
mkdirSync(output, { recursive: true });
const source = join(desktop, "native/runtime-lock/runtime-lock.c");
const binary = join(output, "runtime-lock.node");
let args;
if (platform === "win32" && process.platform !== "win32") {
  args = [
    "-shared",
    "-O2",
    `-I${headers}`,
    source,
    "-o",
    binary,
    "-static-libgcc",
  ];
} else if (process.platform === "win32") {
  if (arch !== process.arch)
    throw new Error(
      "Windows requires matching architecture; run from a Visual Studio developer shell",
    );
  args = [
    "/nologo",
    "/LD",
    "/O2",
    `/I${headers}`,
    source,
    `/Fo${join(output, "runtime-lock.obj")}`,
    "/link",
    `/OUT:${binary}`,
  ];
} else {
  args = [
    "-shared",
    "-fPIC",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${headers}`,
    source,
    "-o",
    binary,
  ];
  if (process.platform === "darwin")
    args.unshift(
      "-arch",
      arch === "x64" ? "x86_64" : "arm64",
      "-undefined",
      "dynamic_lookup",
    );
  else if (arch !== process.arch)
    throw new Error("Cross-compilation is only supported on macOS");
}
const result = spawnSync(
  platform === "win32"
    ? process.platform === "win32"
      ? "cl"
      : "x86_64-w64-mingw32-gcc"
    : "cc",
  args,
  {
    stdio: "inherit",
  },
);
if (
  result.error?.code === "ENOENT" &&
  platform === "win32" &&
  process.platform !== "win32"
)
  throw new Error(
    "Windows cross-compilation requires MinGW-w64: brew install mingw-w64",
  );
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Runtime lock native build failed");
console.log(binary);
