import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function readReleaseConfiguration(root, tag) {
  const version = JSON.parse(
    readFileSync(resolve(root, "apps/desktop/package.json")),
  ).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Stable application version required");
  if (tag !== undefined && tag !== `v${version}`)
    throw new Error("Release tag does not match application version");
  return { version };
}

export function syncReleaseVersion(root, tag) {
  const configuration = readReleaseConfiguration(root, tag);
  const { version } = configuration;
  const changes = [];
  for (const name of [
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
    ["Cargo.lock", /(^name = "nedia-matrix-tauri"\r?\nversion = ")[^"]+("\r?$)/m],
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
  return configuration;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const configuration = syncReleaseVersion(
    resolve(import.meta.dirname, "../.."),
    process.argv[2] ?? process.env.GITHUB_REF_NAME,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${configuration.version}\n`,
    );
  console.log(JSON.stringify(configuration));
}
