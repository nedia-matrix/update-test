import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
    throw new Error(
      "Stable application version required (usage: pnpm version:set X.Y.Z)",
    );
  const changes = [];
  for (const name of [
    "apps/desktop/package.json",
    "apps/tauri/package.json",
    "apps/tauri/src-tauri/tauri.conf.json",
  ]) {
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
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const configuration = setReleaseVersion(
    resolve(import.meta.dirname, "../.."),
    process.argv[2],
  );
  console.log(JSON.stringify(configuration));
}
