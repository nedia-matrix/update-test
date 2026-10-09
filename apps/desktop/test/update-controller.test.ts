import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpdateController,
  type UpdateControllerDependencies,
} from "../src/main/updates/update-controller.js";
import { updateFixture } from "./update-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup(overrides: Partial<UpdateControllerDependencies> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nedia-update-test-"));
  directories.push(directory);
  const fixture = updateFixture();
  const { bytes, signature } = fixture.encode();
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith("update-manifest.json")) return new Response(bytes);
    if (value.endsWith("update-manifest.sig")) return new Response(signature);
    return new Response(fixture.contents, {
      headers: { "content-length": String(fixture.contents.length) },
    });
  });
  const dependencies: UpdateControllerDependencies = {
    currentVersion: "0.3.2",
    source: "github",
    keys: fixture.keys,
    target: { platform: "darwin", arch: "arm64", distribution: "app-zip" },
    cacheDirectory: directory,
    findLatestRelease: vi.fn(async () => fixture.release),
    fetcher,
    ...overrides,
  };
  return {
    fixture,
    directory,
    dependencies,
    fetcher,
    controller: new UpdateController(dependencies),
  };
}

describe("application update lifecycle", () => {
  it("checks without downloading; merges concurrent checks; retains a copy-safe authoritative snapshot", async () => {
    const { controller, fetcher, dependencies } = await setup();
    const first = controller.check();
    expect(controller.check()).toBe(first);
    await expect(first).resolves.toMatchObject({
      status: "update-available",
      latestVersion: "0.4.0",
    });
    expect(dependencies.findLatestRelease).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "available",
      downloadAvailable: true,
      receivedBytes: 0,
    });
    const snapshot = controller.snapshot();
    snapshot.phase = "failed";
    expect(controller.snapshot().phase).toBe("available");
  });

  it("downloads once, promotes only validated files, and restores the cache after a fresh check", async () => {
    const { controller, fixture, dependencies, fetcher } = await setup();
    await controller.check();
    const download = controller.download();
    expect(controller.download()).toBe(download);
    await expect(controller.check()).rejects.toThrow("不能重新检查");
    await download;
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      receivedBytes: fixture.contents.length,
    });
    const file = await controller.verifiedDownloadedFile();
    expect(await readFile(file)).toEqual(fixture.contents);
    const restored = new UpdateController(dependencies);
    await restored.check();
    expect(restored.snapshot().phase).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(5); // two metadata requests per check, one payload
    await writeFile(file, "tampered");
    await expect(restored.verifiedDownloadedFile()).rejects.toThrow(
      "缓存包已变动",
    );
    expect(restored.snapshot()).toMatchObject({
      phase: "failed",
      error: { stage: "download" },
    });
    await restored.download();
    expect(restored.snapshot().phase).toBe("ready");
  });

  it.each(["wrong-size", "wrong-hash", "too-large", "http", "filesystem"])(
    "does not promote corrupted/incomplete downloads: %s",
    async (scenario) => {
      const setupResult = await setup();
      const { controller, fetcher, directory, fixture } = setupResult;
      await controller.check();
      if (scenario === "filesystem") {
        // Replace only the dedicated test cache, never a workspace directory.
        await rm(directory, { recursive: true });
        await writeFile(directory, "not a directory");
      } else if (scenario === "http")
        fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }));
      else {
        const payload =
          scenario === "wrong-size"
            ? fixture.contents.subarray(1)
            : scenario === "too-large"
              ? Buffer.concat([fixture.contents, Buffer.from("!")])
              : Buffer.alloc(fixture.contents.length);
        fetcher.mockResolvedValueOnce(new Response(payload));
      }
      await expect(controller.download()).rejects.toThrow();
      expect(controller.snapshot()).toMatchObject({
        phase: "failed",
        error: { stage: "download", retryable: true },
      });
      await expect(controller.verifiedDownloadedFile()).rejects.toThrow("尚无");
      if (scenario !== "filesystem") {
        for (const entry of await readdir(directory))
          expect(await readdir(join(directory, entry))).toEqual([]);
        await controller.download();
        expect(controller.snapshot().phase).toBe("ready");
      }
    },
  );

  it.each(["cancel", "timeout"])(
    "aborts streaming downloads with cleanup and supports a new task: %s",
    async (scenario) => {
      const { controller, fetcher, fixture, directory } = await setup({
        downloadTimeoutMs: 40,
      });
      await controller.check();
      let streaming!: () => void;
      const started = new Promise<void>((resolve) => {
        streaming = resolve;
      });
      fetcher.mockImplementationOnce(
        async (_url, options?: RequestInit) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(fixture.contents.subarray(0, 2));
                options!.signal!.addEventListener(
                  "abort",
                  () => stream.error(options!.signal!.reason),
                  { once: true },
                );
                streaming();
              },
            }),
          ),
      );
      const first = controller.download();
      const observed = first.catch((error: unknown) => error);
      await started;
      const taskId = controller.snapshot().taskId;
      if (scenario === "cancel") await controller.cancel();
      const result = await observed;
      if (scenario === "timeout") expect(result).toBeInstanceOf(Error);
      expect(controller.snapshot().phase).toBe(
        scenario === "cancel" ? "available" : "failed",
      );
      for (const entry of await readdir(directory))
        expect(await readdir(join(directory, entry))).toEqual([]);
      await controller.download();
      expect(controller.snapshot().phase).toBe("ready");
      expect(controller.snapshot().taskId).not.toBe(taskId);
    },
  );

  it("keeps legacy, unconfigured and unsupported builds on the manual path", async () => {
    const legacy = await setup({
      findLatestRelease: async () => ({ version: "0.4.0" }),
    });
    await legacy.controller.check();
    expect(legacy.controller.snapshot()).toMatchObject({
      phase: "available",
      downloadAvailable: false,
    });
    expect(legacy.fetcher).not.toHaveBeenCalled();
    const noKeys = await setup({ keys: {} });
    await noKeys.controller.check();
    expect(noKeys.controller.snapshot().downloadAvailable).toBe(false);
    const unsupported = await setup({
      target: { platform: "linux", arch: "x64", distribution: "unsupported" },
    });
    await unsupported.controller.check();
    expect(unsupported.controller.snapshot()).toMatchObject({
      phase: "available",
      downloadAvailable: false,
    });
    await expect(unsupported.controller.download()).rejects.toThrow(
      "可信更新包",
    );
  });

  it("fails closed on signature tampering or incomplete assets rather than saying up-to-date", async () => {
    const { controller, fetcher } = await setup();
    fetcher.mockResolvedValueOnce(new Response("{}"));
    await expect(controller.check()).rejects.toThrow();
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      downloadAvailable: false,
      error: { stage: "check" },
    });
    const incomplete = await setup();
    incomplete.fixture.release.assets!.pop();
    await expect(incomplete.controller.check()).rejects.toThrow("附件缺失");
  });

  it("does not fetch metadata or download when already current", async () => {
    const { controller, fetcher } = await setup({ currentVersion: "0.4.0" });
    await expect(controller.check()).resolves.toMatchObject({
      status: "up-to-date",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("user requested installation", () => {
  it("does not install until requested; merges requests and pins source/package during preflight", async () => {
    let finish!: () => void;
    const installer = vi.fn(async (_update, installing) => {
      installing();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { controller, fixture } = await setup({ install: installer });
    await controller.check();
    await controller.download();
    expect(installer).not.toHaveBeenCalled();
    expect(controller.snapshot().installAction).toBe("restart");
    const installation = controller.install();
    expect(controller.install()).toBe(installation);
    expect(() => controller.resetSource()).toThrow("安装");
    await expect(controller.check()).rejects.toThrow("不能重新检查");
    await expect(controller.download()).rejects.toThrow();
    await vi.waitFor(() => expect(installer).toHaveBeenCalledOnce());
    expect(installer.mock.calls[0]![0]).toMatchObject({
      version: "0.4.0",
      artifact: fixture.manifest.artifacts[0],
    });
    expect(controller.snapshot().phase).toBe("installing");
    finish();
    await installation;
  });
  it("rejects a mutated cache before starting the helper", async () => {
    const installer = vi.fn();
    const { controller } = await setup({ install: installer });
    await controller.check();
    await controller.download();
    await writeFile(await controller.verifiedDownloadedFile(), "changed");
    await expect(controller.install()).rejects.toThrow("缓存包已变动");
    expect(installer).not.toHaveBeenCalled();
    expect(controller.snapshot().error?.stage).toBe("download");
  });
  it("keeps the verified package retryable after preflight fails", async () => {
    const installer = vi.fn(async () => {
      throw new Error("活动发布阻止安装");
    });
    const { controller } = await setup({ install: installer });
    await controller.check();
    await controller.download();
    await expect(controller.install()).rejects.toThrow("活动发布");
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      error: { stage: "install", retryable: true },
    });
    await expect(controller.verifiedDownloadedFile()).resolves.toBeTypeOf(
      "string",
    );
  });
  it("does not offer a second installation after cleanup fails", async () => {
    const { controller } = await setup({
      install: async (_update, installing) => {
        installing();
        throw new Error("清理失败，请重启");
      },
    });
    await controller.check();
    await controller.download();
    await expect(controller.install()).rejects.toThrow("清理失败");
    expect(controller.snapshot()).toMatchObject({
      phase: "failed",
      error: { stage: "install", retryable: false },
    });
    await expect(controller.install()).rejects.toThrow("尚无可安装");
    await expect(controller.verifiedDownloadedFile()).resolves.toBeTypeOf(
      "string",
    );
  });
});
