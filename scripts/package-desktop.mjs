#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { publicKeyFingerprint, sha256File } from "./update-manifest.mjs";
import { configuredPublicKeys } from "./update-keys.mjs";
import { updateArtifactTargets } from "./update-manifest.mjs";

const desktop = resolve(import.meta.dirname, "../apps/desktop");
const mode = process.argv[2];
if (!["mac", "win", "win:portable"].includes(mode))
  throw new Error("未知打包平台");
const version = JSON.parse(
  await readFile(join(desktop, "package.json"), "utf8"),
).version;
const publicKeys = configuredPublicKeys();
const trustedKeyFingerprints =
  Object.values(publicKeys).map(publicKeyFingerprint);

function run(args, distribution) {
  const environment = {
    ...process.env,
    NEDIA_UPDATE_DISTRIBUTION: distribution,
  };
  // Packaging subprocesses never receive release credentials.
  delete environment.NEDIA_UPDATE_PRIVATE_KEY;
  delete environment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
  const result = spawnSync("pnpm", args, {
    cwd: desktop,
    env: environment,
    stdio: "inherit",
    // pnpm.cmd requires cmd.exe on Windows; arguments below are fixed constants.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("桌面打包失败");
}

async function provenance(distribution, names) {
  for (const name of names) {
    const file = join(desktop, "dist", name);
    const target = updateArtifactTargets(version).find(
      (target) => target.assetName === name,
    );
    await writeFile(
      `${file}.provenance.json`,
      `${JSON.stringify({ appId: "com.nediamatrix.desktop", version, platform: target.platform, arch: target.arch, distribution, sha256: await sha256File(file), trustedKeyFingerprints }, null, 2)}\n`,
    );
  }
}

const helperBuildEnvironment = { ...process.env };
delete helperBuildEnvironment.NEDIA_UPDATE_PRIVATE_KEY;
delete helperBuildEnvironment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
const helperBuild = spawnSync(
  process.execPath,
  [
    join(import.meta.dirname, "build-update-helper.mjs"),
    mode === "mac" ? "mac" : "win",
  ],
  { stdio: "inherit", env: helperBuildEnvironment },
);
if (helperBuild.error) throw helperBuild.error;
if (helperBuild.status !== 0) throw new Error("更新辅助程序构建失败");

if (mode === "mac") {
  run(["run", "build"], "app-zip");
  run(["exec", "electron-builder", "--mac", "--publish", "never"], "app-zip");
  await provenance(
    "app-zip",
    ["arm64", "x64"].map((arch) => `NediaMatrix-${version}-mac-${arch}.zip`),
  );
} else {
  // Separate compilations: portable and NSIS must NOT share a distribution marker.
  for (const distribution of mode === "win:portable"
    ? ["portable"]
    : ["nsis", "portable"]) {
    run(["run", "build"], distribution);
    run(
      [
        "exec",
        "electron-builder",
        "--win",
        distribution,
        "--x64",
        "--publish",
        "never",
      ],
      distribution,
    );
    await provenance(distribution, [
      `NediaMatrix-${version}-win-${distribution === "nsis" ? "setup" : "portable"}-x64.exe`,
    ]);
  }
}
