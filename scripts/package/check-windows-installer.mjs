import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { buildTauriNsis } from "./build-tauri-nsis.mjs";

const desktop = resolve(import.meta.dirname, "../../apps/desktop");
const metadata = JSON.parse(readFileSync(join(desktop, "package.json")));

export async function verifyWindowsInstallers() {
  assert.equal(process.platform, "win32");
  assert.equal(process.env.NEDIA_VERIFY_NSIS_INSTALL, "1");
  // Installation tests use the real product identity. Only disposable GitHub
  // runners may run them; never overwrite a developer's installed application.
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const root = mkdtempSync(join(tmpdir(), "nedia-nsis-test-"));
  try {
    const builder = createRequire(join(desktop, "package.json")).resolve(
      "electron-builder/cli.js",
    );
    const [major, minor, patch] = metadata.version.split(".").map(Number);
    assert.ok(major > 0 || minor > 0 || patch > 0);
    const oldVersion =
      patch > 0
        ? `${major}.${minor}.${patch - 1}`
        : minor > 0
          ? `${major}.${minor - 1}.0`
          : `${major - 1}.0.0`;
    const futureVersion = `${major + 1}.0.0`;
    const installers = [];
    for (const [shell, version] of [
      ["old-electron", oldVersion],
      ["tauri", metadata.version],
      ["electron", futureVersion],
    ]) {
      const payload = join(root, shell, "payload");
      mkdirSync(payload, { recursive: true });
      // A tiny native fixture exercises the actual installer engine, not the UI
      // or runtime migration. Launching is disabled by silent installation.
      copyFileSync(
        join(process.env.SystemRoot, "System32/ping.exe"),
        join(payload, "NediaMatrix.exe"),
      );
      const marker =
        shell === "tauri" ? "runtime/sidecar.mjs" : "resources/app.asar";
      mkdirSync(join(payload, marker, ".."), { recursive: true });
      writeFileSync(join(payload, marker), shell);
      writeFileSync(join(payload, `${shell}.txt`), version);
      const output = join(root, shell, "output");
      if (shell === "tauri") {
        installers.push(await buildTauriNsis(payload, output, version));
      } else {
        const nsis = { ...metadata.build.nsis };
        if (shell === "old-electron") delete nsis.include;
        const config = join(root, shell, "builder.json");
        writeFileSync(
          config,
          JSON.stringify({
            ...metadata.build,
            extraMetadata: { version },
            directories: { ...metadata.build.directories, output },
            nsis,
          }),
        );
        execFileSync(
          process.execPath,
          [
            builder,
            "--win",
            "nsis",
            "--x64",
            "--prepackaged",
            payload,
            "--config",
            config,
            "--publish",
            "never",
          ],
          {
            cwd: desktop,
            stdio: "inherit",
            env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
          },
        );
        installers.push(
          join(output, `NediaMatrix-${version}-win-setup-x64.exe`),
        );
      }
    }
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(import.meta.dirname, "./check-windows-installer.ps1"),
        "-OldInstaller",
        installers[0],
        "-TauriInstaller",
        installers[1],
        "-ElectronInstaller",
        installers[2],
        "-FixtureRoot",
        root,
      ],
      { stdio: "inherit", timeout: 10 * 60 * 1000 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await verifyWindowsInstallers();
}
