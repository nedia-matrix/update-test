import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionFiles = [
  "apps/desktop/package.json",
  "apps/tauri/package.json",
  "apps/tauri/src-tauri/tauri.conf.json",
  "apps/tauri/src-tauri/Cargo.toml",
  "apps/tauri/src-tauri/Cargo.lock",
];

export function readReleaseConfiguration(root, tag) {
  const version = JSON.parse(
    readFileSync(resolve(root, "apps/desktop/package.json")),
  ).version;
  if (!stableVersion.test(version))
    throw new Error("Stable application version required");
  if (tag !== undefined && tag !== `v${version}`)
    throw new Error("Release tag does not match application version");
  return { version };
}

export function setReleaseVersion(root, version) {
  if (typeof version !== "string" || !stableVersion.test(version))
    throw new Error("Stable application version required");
  const changes = [];
  for (const name of versionFiles.slice(0, 3)) {
    const file = resolve(root, name);
    const original = readFileSync(file, "utf8");
    const value = JSON.parse(original);
    value.version = version;
    changes.push([file, original, `${JSON.stringify(value, null, 2)}\n`]);
  }
  for (const [name, section] of [
    [
      "Cargo.toml",
      /(^\[package\]\r?\n(?:(?!\[)[^\n]*\n)*?version = ")[^"]+("\r?$)/m,
    ],
    [
      "Cargo.lock",
      /(^name = "nedia-matrix-tauri"\r?\nversion = ")[^"]+("\r?$)/m,
    ],
  ]) {
    const file = resolve(root, "apps/tauri/src-tauri", name);
    const original = readFileSync(file, "utf8");
    if (!section.test(original))
      throw new Error(`Missing application version: ${name}`);
    changes.push([
      file,
      original,
      original.replace(
        section,
        (_, before, after) => `${before}${version}${after}`,
      ),
    ]);
  }
  for (const [file, original, updated] of changes)
    if (original !== updated) writeFileSync(file, updated);
  return { version };
}

export function upReleaseVersion(root, args = []) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (
    git(
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--ignore-submodules=untracked",
    )
  )
    throw new Error(
      "Tracked files have uncommitted changes; commit or stash them first",
    );

  const indices = { major: 0, minor: 1, patch: 2, 1: 0, 2: 1, 3: 2 };
  const part = args[0] ?? "patch";
  if (args.length > 1 || !Object.hasOwn(indices, part))
    throw new Error(
      "Usage: node scripts/publish/release-version.mjs [major|minor|patch|1|2|3]",
    );
  const { version: current } = readReleaseConfiguration(root);
  const segments = current.split(".").map(BigInt);
  const index = indices[part];
  segments[index] += 1n;
  segments.fill(0n, index + 1);
  const version = segments.join(".");
  const tag = `v${version}`;
  if (git("tag", "--list", tag))
    throw new Error(`Release tag already exists: ${tag}`);

  setReleaseVersion(root, version);
  git("add", "--", ...versionFiles);
  git("commit", "-m", tag);
  git("tag", tag);
  return { version, tag };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const configuration = upReleaseVersion(
      resolve(import.meta.dirname, "../.."),
      process.argv.slice(2),
    );
    console.log(JSON.stringify(configuration));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
