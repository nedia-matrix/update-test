import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { homedir, tmpdir } from "node:os";
import { platformPluginBuildEnvironment } from "../../scripts/package/platform-plugin-packaging.mjs";
import { buildTauriPortable } from "../../scripts/package/build-tauri-portable.mjs";
import { buildTauriNsis } from "../../scripts/package/build-tauri-nsis.mjs";
import { configuredPublicKeys } from "../../scripts/publish/update-keys.mjs";
import { readReleaseConfiguration } from "../../scripts/publish/up-release-version.mjs";
import {
  publicKeyFingerprint,
  sha256File,
  updateArtifactTargets,
} from "../../scripts/publish/update-manifest.mjs";
const here = import.meta.dirname;
const root = resolve(here, "../..");
const mode = process.argv[2];
if (!["dev", "package"].includes(mode))
  throw new Error("Expected dev or package");
if (mode === "package" && !["darwin", "win32"].includes(process.platform))
  throw new Error("Release packaging currently supports macOS and Windows");
const { version } = readReleaseConfiguration(root);
const env = {
  ...process.env,
  PATH: `${join(homedir(), ".cargo/bin")}${delimiter}${process.env.PATH}`,
};
if (mode === "package") {
  const signing = platformPluginBuildEnvironment(env, root);
  if (signing)
    execFileSync(
      process.execPath,
      [join(root, "scripts/package/build-platform-plugins.mjs")],
      { cwd: root, env: signing, stdio: "inherit" },
    );
  env.NEDIA_TAURI_PLUGIN_TRUST = "release";
}
// Only the plugin signing subprocess receives private keys.
delete env.NEDIA_UPDATE_PRIVATE_KEY;
delete env.NEDIA_UPDATE_PRIVATE_KEY_FILE;
const args =
  mode === "dev"
    ? ["exec", "tauri", "dev"]
    : [
        "exec",
        "tauri",
        "build",
        ...(process.platform === "darwin"
          ? ["--bundles", "app"]
          : ["--no-bundle"]),
        "--",
        "--locked",
      ];
execFileSync("pnpm", args, {
  cwd: here,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (mode === "package") {
  const bundle = resolve(here, "src-tauri/target/release/bundle");
  const output = join(here, "dist-installers");
  mkdirSync(output, { recursive: true });
  const targets = updateArtifactTargets(version, "tauri").filter(
    (target) =>
      target.platform === process.platform && target.arch === process.arch,
  );
  if (!targets.length) throw new Error("Unsupported release target");
  const artifacts = [];
  const artifact = join(output, targets[0].assetName);
  if (process.platform === "darwin") {
    // hdiutil avoids Finder automation, which can time out on unattended Macs.
    const stage = mkdtempSync(join(tmpdir(), "nedia-tauri-dmg-"));
    const app = "NediaMatrix.app";
    try {
      cpSync(join(bundle, "macos", app), join(stage, app), { recursive: true });
      execFileSync(
        "ditto",
        ["-c", "-k", "--keepParent", join(stage, app), artifact],
        { stdio: "inherit" },
      );
      const entries = execFileSync("unzip", ["-Z", "-1", artifact], {
        encoding: "utf8",
      })
        .trim()
        .split("\n");
      if (
        entries.some((entry) => entry !== app && !entry.startsWith(`${app}/`))
      )
        throw new Error(
          "Update ZIP contains files outside the application bundle",
        );
      symlinkSync("/Applications", join(stage, "Applications"));
      execFileSync(
        "hdiutil",
        [
          "create",
          "-ov",
          "-format",
          "UDZO",
          "-volname",
          "NediaMatrix",
          "-srcfolder",
          stage,
          artifact.replace(/\.zip$/, ".dmg"),
        ],
        { stdio: "inherit" },
      );
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  if (process.platform === "darwin") artifacts.push(artifact);
  if (process.platform === "win32") {
    const portable = targets.find(
      (target) => target.distribution === "portable",
    );
    if (!portable) throw new Error("Missing Windows portable target");
    const stage = mkdtempSync(join(tmpdir(), "nedia-tauri-portable-"));
    try {
      cpSync(
        join(here, "src-tauri/target/release/nedia-matrix-tauri.exe"),
        join(stage, "NediaMatrix.exe"),
      );
      cpSync(join(here, "runtime"), join(stage, "runtime"), {
        recursive: true,
      });
      artifacts.push(
        buildTauriPortable(stage, join(output, portable.assetName), version),
      );
      artifacts.push(await buildTauriNsis(stage, output, version, env));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  for (const artifact of artifacts) {
    const target = targets.find(
      (target) => join(output, target.assetName) === artifact,
    );
    writeFileSync(
      `${artifact}.provenance.json`,
      `${JSON.stringify({ ...target, appId: "com.nediamatrix.desktop", shell: "tauri", version, sha256: await sha256File(artifact), trustedKeyFingerprints: Object.values(configuredPublicKeys()).map(publicKeyFingerprint) }, null, 2)}\n`,
    );
    console.log(`Release package: ${artifact}`);
  }
}
