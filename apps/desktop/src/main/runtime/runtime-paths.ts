import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RuntimePaths {
  shell: "electron" | "tauri";
  environment: "production" | "development" | "prototype" | "coexistence-test";
  businessDirectory: string;
  shellDirectory: string;
}
export interface RuntimePathInput {
  shell: RuntimePaths["shell"];
  environment: Exclude<RuntimePaths["environment"], "coexistence-test">;
  legacyDirectory: string;
  testRoot?: string;
  sharedDirectory?: string;
}

export function resolveRuntimePaths(input: RuntimePathInput): RuntimePaths {
  if (!isAbsolute(input.legacyDirectory))
    throw new Error("Runtime data directory must be absolute");
  if (input.testRoot === undefined) {
    if (
      input.sharedDirectory !== undefined &&
      !isAbsolute(input.sharedDirectory)
    )
      throw new Error("Shared userData directory must be absolute");
    const directory = resolve(input.sharedDirectory ?? input.legacyDirectory);
    return {
      shell: input.shell,
      environment: input.environment,
      businessDirectory: directory,
      // Preserve Electron update handoff paths and prototype defaults.
      shellDirectory: resolve(input.legacyDirectory),
    };
  }
  if (!isAbsolute(input.testRoot))
    throw new Error("Coexistence test root must be absolute");
  const root = realpathSync.native(input.testRoot);
  const temporary = realpathSync.native(tmpdir());
  const nested = relative(temporary, root);
  if (
    !nested ||
    nested === ".." ||
    nested.startsWith(`..${sep}`) ||
    isAbsolute(nested)
  ) {
    throw new Error(
      "Coexistence testing requires a directory inside the system temporary directory",
    );
  }
  const marker: unknown = JSON.parse(
    readFileSync(join(root, ".nedia-coexistence-test.json"), "utf8"),
  );
  if (
    typeof marker !== "object" ||
    marker === null ||
    !("schemaVersion" in marker) ||
    marker.schemaVersion !== 1
  ) {
    throw new Error("Missing or invalid coexistence test marker");
  }
  const businessDirectory = join(root, "business");
  const shellDirectory = join(root, "shells", input.shell);
  // Existing directory aliases must not redirect writes outside the fixture.
  // Missing directories will be created only after resolution by the bootstrap.
  for (const directory of [
    businessDirectory,
    join(root, "shells"),
    shellDirectory,
  ]) {
    try {
      if (realpathSync.native(directory) !== directory)
        throw new Error("Coexistence test directories must not be aliases");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    shell: input.shell,
    environment: "coexistence-test",
    businessDirectory,
    shellDirectory,
  };
}

let active: RuntimePaths | undefined;
export function configureRuntimePaths(input: RuntimePathInput): RuntimePaths {
  if (active) throw new Error("Runtime paths are already configured");
  active = resolveRuntimePaths(input);
  return active;
}
export function configuredRuntimePaths(): RuntimePaths | undefined {
  return active;
}

/** Preserve the established Electron package identity, independent of the Tauri bundle ID. */
export function electronUserDataDirectory(appDataDirectory: string): string {
  if (!appDataDirectory || !isAbsolute(appDataDirectory))
    throw new Error(
      "Electron appData directory is required and must be absolute",
    );
  return join(appDataDirectory, "@nedia-matrix/desktop");
}
