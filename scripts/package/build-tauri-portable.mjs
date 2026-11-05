import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NtExecutable, NtExecutableResource, Resource, Data } from "resedit";

const source = resolve(import.meta.dirname, "../../apps/tauri/portable");
// Used by Tauri Windows packaging and the standalone compatibility verifier.
export function buildTauriPortable(payloadDirectory, output, version) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split(".").some((part) => Number(part) > 65535)
  )
    throw new Error("Invalid portable product version");
  payloadDirectory = resolve(payloadDirectory);
  output = resolve(output);
  for (const name of [
    "NediaMatrix.exe",
    "runtime/node.exe",
    "runtime/sidecar.mjs",
    "runtime/native/win32-x64/runtime-lock.node",
    "runtime/update-helper/nedia-update-helper.exe",
  ]) {
    const file = lstatSync(join(payloadDirectory, name));
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error(`Missing regular portable payload: ${name}`);
  }
  const temporary = mkdtempSync(join(tmpdir(), "nedia-portable-build-"));
  const env = { ...process.env };
  delete env.NEDIA_UPDATE_PRIVATE_KEY;
  delete env.NEDIA_UPDATE_PRIVATE_KEY_FILE;
  // Never let inherited cross-compilation flags affect the host ZIP writer.
  delete env.GOOS;
  delete env.GOARCH;
  try {
    const zip = join(temporary, "payload.zip");
    execFileSync("go", ["run", "./cmd/pack", payloadDirectory, zip], {
      cwd: source,
      env,
      stdio: "inherit",
    });
    const stub = join(temporary, "launcher.exe");
    execFileSync(
      "go",
      ["build", "-trimpath", "-ldflags=-s -w -H=windowsgui", "-o", stub, "."],
      {
        cwd: source,
        env: { ...env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
        stdio: "inherit",
      },
    );
    const executable = NtExecutable.from(readFileSync(stub));
    const resources = NtExecutableResource.from(executable);
    const info = Resource.VersionInfo.createEmpty();
    info.setFileVersion(version, 1033);
    info.setProductVersion(version, 1033);
    info.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        ProductName: "NediaMatrix",
        FileDescription: "NediaMatrix",
        OriginalFilename: "NediaMatrix.exe",
      },
    );
    info.outputToResourceEntries(resources.entries);
    const icon = Data.IconFile.from(
      readFileSync(resolve(source, "../../desktop/resources/icon.ico")),
    );
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      101,
      1033,
      icon.icons.map((item) => item.data),
    );
    resources.outputResource(executable);
    const archive = readFileSync(zip);
    const trailer = Buffer.alloc(56);
    trailer.write("NEDIA-PORTABLE01");
    trailer.writeBigUInt64LE(BigInt(archive.length), 16);
    createHash("sha256").update(archive).digest().copy(trailer, 24);
    mkdirSync(dirname(output), { recursive: true });
    const packaged = join(temporary, "portable.exe");
    writeFileSync(
      packaged,
      Buffer.concat([Buffer.from(executable.generate()), archive, trailer]),
    );
    copyFileSync(packaged, output);
    return output;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [payload, output, version, ...extra] = process.argv.slice(2);
  if (!payload || !output || !version || extra.length)
    throw new Error(
      "Usage: build-tauri-portable.mjs <payload-directory> <output.exe> <version>",
    );
  console.log(buildTauriPortable(payload, output, version));
}
