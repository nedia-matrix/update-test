import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const desktop = resolve(import.meta.dirname, "../../apps/desktop");
const preflight = join(import.meta.dirname, "windows-installer.ps1");
const include = join(import.meta.dirname, "windows-installer.nsh");
const bootstrapperUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const builder = createRequire(join(desktop, "package.json")).resolve(
  "electron-builder/cli.js",
);

function nsisString(value) {
  return value.replaceAll("$", () => "$$").replaceAll('"', () => '$\\"');
}

// Use the original installer engine for a prebuilt native payload. No Electron
// runtime is copied: --prepackaged bypasses application packing completely.
export async function buildTauriNsis(
  payload,
  output,
  version,
  env = process.env,
) {
  if (process.platform !== "win32")
    throw new Error("NSIS packaging requires Windows");
  const metadata = JSON.parse(
    readFileSync(join(desktop, "package.json"), "utf8"),
  );
  if (metadata.version !== version)
    throw new Error("Desktop shell versions must match");
  if (
    !existsSync(join(payload, "NediaMatrix.exe")) ||
    !existsSync(join(payload, "runtime/sidecar.mjs"))
  )
    throw new Error("Incomplete Tauri installer payload");
  const temporary = mkdtempSync(join(tmpdir(), "nedia-tauri-nsis-"));
  const environment = { ...env };
  delete environment.NEDIA_UPDATE_PRIVATE_KEY;
  delete environment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
  try {
    const bootstrapper = join(temporary, "MicrosoftEdgeWebview2Setup.exe");
    const response = await fetch(bootstrapperUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`WebView2 download failed: ${response.status}`);
    writeFileSync(bootstrapper, Buffer.from(await response.arrayBuffer()));
    // TLS alone is insufficient for an executable dependency. Verify Windows'
    // certificate chain and the publisher before embedding, and again at install.
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        preflight,
        "-Mode",
        "VerifyBootstrapper",
        "-Bootstrapper",
        bootstrapper,
      ],
      { env: environment, stdio: "inherit" },
    );
    const hooks = join(temporary, "installer.nsh");
    writeFileSync(
      hooks,
      `!define NEDIA_WEBVIEW2_BOOTSTRAPPER "${nsisString(bootstrapper)}"\n!include "${nsisString(include)}"\n`,
    );
    const config = join(temporary, "electron-builder.json");
    const buildOutput = join(temporary, "output");
    writeFileSync(
      config,
      JSON.stringify({
        ...metadata.build,
        directories: { ...metadata.build.directories, output: buildOutput },
        nsis: { ...metadata.build.nsis, include: hooks },
      }),
    );
    // NSIS adds its scope-elevation helper here even for prepackaged apps.
    mkdirSync(join(payload, "resources"), { recursive: true });
    execFileSync(
      process.execPath,
      [
        builder,
        "--win",
        "nsis",
        "--x64",
        "--prepackaged",
        resolve(payload),
        "--config",
        config,
        "--publish",
        "never",
      ],
      { cwd: desktop, env: environment, stdio: "inherit" },
    );
    const name = `NediaMatrix-${version}-win-setup-x64.exe`;
    const packaged = join(buildOutput, name);
    if (!existsSync(packaged)) throw new Error("Missing NSIS installer");
    mkdirSync(output, { recursive: true });
    const artifact = join(output, name);
    copyFileSync(packaged, artifact);
    return artifact;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
