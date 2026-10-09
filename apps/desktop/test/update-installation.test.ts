import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  installationTarget,
  recordUpdateStartup,
  type InstallContext,
} from "../src/main/updates/update-installation.js";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "nedia-install-test-"));
  directories.push(directory);
  // Use a canonical path on macOS, where /var is a symlink to /private/var.
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(directory);
  const target = join(root, "NediaMatrix.app");
  await mkdir(target);
  const context: InstallContext = {
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    distribution: "app-zip",
    executable: join(target, "Contents", "MacOS", "NediaMatrix"),
    resources: root,
    userData: root,
    currentVersion: "0.4.0",
  };
  return { context, root, target };
}
it("rejects development installs and ambiguous portable launcher paths", async () => {
  const { context, root } = await setup();
  await expect(
    installationTarget({ ...context, packaged: false }),
  ).rejects.toThrow("开发环境");
  const windows = { ...context, platform: "win32", distribution: "portable" };
  await expect(installationTarget(windows)).rejects.toThrow("原始 EXE");
  const launcher = join(root, "renamed portable.exe");
  await writeFile(launcher, "fixture");
  await expect(
    installationTarget({
      ...windows,
      portableExecutable: launcher,
      portableDirectory: root,
    }),
  ).resolves.toBe(launcher);
  await expect(
    installationTarget({
      ...windows,
      portableExecutable: launcher,
      portableDirectory: join(root, "wrong"),
    }),
  ).rejects.toThrow("不一致");
});
it("rejects a symlink target instead of following it for replacement", async () => {
  const { context, target, root } = await setup();
  const linked = join(root, "Linked.app");
  await symlink(target, linked);
  await expect(
    installationTarget({
      ...context,
      executable: join(linked, "Contents", "MacOS", "NediaMatrix"),
    }),
  ).rejects.toThrow("目标类型");
});
it("records migration and success only for the matching version, target and distribution", async () => {
  const { context, root, target } = await setup();
  const id = "12345678-1234-1234-1234-123456789abc";
  const directory = join(root, "application-updates", "installations", id);
  await mkdir(directory, { recursive: true });
  const journal = {
    stage: "launching",
    request: {
      id,
      appId: "com.nediamatrix.desktop",
      version: "0.4.0",
      target,
      distribution: "app-zip",
      platform: "darwin",
      arch: "arm64",
    },
  };
  await writeFile(join(directory, "journal.json"), JSON.stringify(journal));
  await recordUpdateStartup({ ...context, currentVersion: "0.3.3" }, true);
  await expect(readFile(join(directory, "success"))).rejects.toThrow();
  await recordUpdateStartup(context, false);
  expect(await readFile(join(directory, "migration-started"), "utf8")).toBe(id);
  await expect(readFile(join(directory, "success"))).rejects.toThrow();
  await recordUpdateStartup(context, true);
  expect(await readFile(join(directory, "success"), "utf8")).toBe(id);
});
it("ignores malformed unrelated journals so they cannot prevent application startup", async () => {
  const { context, root } = await setup();
  const directory = join(
    root,
    "application-updates",
    "installations",
    "12345678-1234-1234-1234-123456789abc",
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "journal.json"), "incomplete");
  await expect(recordUpdateStartup(context, false)).resolves.toBeUndefined();
});
