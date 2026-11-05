import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const arch = process.argv[2] ?? process.arch;
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
let nodeLibrary = process.env.NEDIA_NODE_LIB;
if (process.platform === "win32" && !nodeLibrary) {
  nodeLibrary = join(cache, "node.lib");
  if (!existsSync(nodeLibrary))
    fetchOfficial(`win-${arch}/node.lib`, nodeLibrary);
}
const output = join(desktop, "resources/native", `${process.platform}-${arch}`);
mkdirSync(output, { recursive: true });
const source = join(desktop, "native/runtime-lock/runtime-lock.c");
const binary = join(output, "runtime-lock.node");
let args;
if (process.platform === "win32") {
  if (arch !== process.arch || !nodeLibrary)
    throw new Error(
      "Windows requires matching architecture and NEDIA_NODE_LIB pointing to node.lib; run from a Visual Studio developer shell",
    );
  args = [
    "/nologo",
    "/LD",
    "/O2",
    `/I${headers}`,
    source,
    `/Fo${join(output, "runtime-lock.obj")}`,
    "/link",
    nodeLibrary,
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
const result = spawnSync(process.platform === "win32" ? "cl" : "cc", args, {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Runtime lock native build failed");
console.log(binary);
