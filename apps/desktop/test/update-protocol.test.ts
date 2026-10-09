import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { updateFixture } from "./update-fixtures.js";
import { findProtocolUpdate } from "../src/main/updates/find-protocol-update.js";
import { parseUpdateSource } from "../src/main/updates/update-source.js";
import { verifyUpdateManifest } from "../src/main/updates/update-manifest.js";
import { UpdateController } from "../src/main/updates/update-controller.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function fixtureManifest() {
  const fixture = updateFixture();
  const manifest = {
    ...fixture.manifest,
    appId: "com.nediamatrix.desktop",
    artifacts: fixture.manifest.artifacts.map((artifact) => ({
      ...artifact,
      url: `https://downloads.example.com/${artifact.assetName}`,
    })),
  };
  const encoded = fixture.encode(manifest);
  const fetcher = vi.fn(
    async (input: string | URL | Request) =>
      new Response(
        String(input).endsWith(".sig")
          ? encoded.signature
          : String(input).endsWith(".json")
            ? encoded.bytes
            : fixture.contents,
      ),
  );
  return { ...fixture, manifest, encoded, fetcher };
}

it("fetches the configured signature sibling, verifies raw bytes, and downloads a signed CDN URL", async () => {
  const fixture = fixtureManifest();
  const source = parseUpdateSource(
    "https://updates.example.com/stable/update-manifest.json",
  );
  if (source.kind !== "manifest") throw new Error("wrong source");
  const release = await findProtocolUpdate(
    source,
    fixture.keys,
    fixture.fetcher,
  );
  const directory = await mkdtemp(join(tmpdir(), "matrix-protocol-"));
  directories.push(directory);
  const dependencies = {
    currentVersion: "0.3.2",
    source: "manifest" as const,
    sourceIdentity: source.url,
    keys: fixture.keys,
    target: { platform: "darwin", arch: "arm64", distribution: "app-zip" },
    cacheDirectory: directory,
    findLatestRelease: async () => release,
    fetcher: fixture.fetcher,
  };
  const controller = new UpdateController(dependencies);
  await controller.check();
  expect(controller.snapshot()).toMatchObject({
    phase: "available",
    downloadAvailable: true,
  });
  await controller.download();
  expect(controller.snapshot().phase).toBe("ready");
  expect(fixture.fetcher).toHaveBeenCalledWith(
    fixture.manifest.artifacts[0]!.url,
    expect.anything(),
  );
  const other = new UpdateController({
    ...dependencies,
    sourceIdentity: "https://other.example.com/update-manifest.json",
  });
  await other.check();
  expect(other.snapshot().phase).toBe("available");
  controller.resetSource();
  await expect(controller.verifiedDownloadedFile()).rejects.toThrow();
});

it.each([
  { appId: "another.app" },
  { appId: undefined },
  { version: "0.4.0-beta" },
  { artifacts: [] },
])(
  "rejects signed but invalid identity/required fields/targets %j",
  (patch) => {
    const fixture = fixtureManifest();
    const { bytes, signature } = fixture.encode({
      ...fixture.manifest,
      ...patch,
    });
    expect(() =>
      verifyUpdateManifest(bytes, signature, fixture.keys, {}),
    ).toThrow();
  },
);

it("only retries a cross-publication signature race once; corrupted metadata is never accepted", async () => {
  const fixture = fixtureManifest();
  const source = parseUpdateSource(
    "https://updates.example.com/update-manifest.json",
  );
  if (source.kind !== "manifest") throw new Error("wrong source");
  const wrong = fixture.encode({ ...fixture.manifest, version: "0.5.0" });
  fixture.fetcher.mockImplementation(
    async (input) =>
      new Response(
        String(input).endsWith(".sig")
          ? wrong.signature
          : fixture.encoded.bytes,
      ),
  );
  await expect(
    findProtocolUpdate(source, fixture.keys, fixture.fetcher),
  ).rejects.toThrow("签名验证失败");
  expect(fixture.fetcher).toHaveBeenCalledTimes(4);
});

it("GitHub refuses a partial or corrupted manifest", async () => {
  const fixture = fixtureManifest();
  const directory = await mkdtemp(join(tmpdir(), "matrix-protocol-"));
  directories.push(directory);
  const assets = [
    ...fixture.release.assets!.filter(
      (asset) => !asset.name.startsWith("update-manifest."),
    ),
    {
      name: "update-manifest.json",
      url: fixture.url("update-manifest.json"),
    },
    {
      name: "update-manifest.sig",
      url: fixture.url("update-manifest.sig"),
    },
  ];
  const dependencies = {
    currentVersion: "0.3.2",
    source: "github" as const,
    keys: fixture.keys,
    target: { platform: "darwin", arch: "arm64", distribution: "app-zip" },
    cacheDirectory: directory,
    fetcher: fixture.fetcher,
  };
  await new UpdateController({
    ...dependencies,
    findLatestRelease: async () => ({ version: "0.4.0", assets }),
  }).check();
  expect(
    fixture.fetcher.mock.calls.every(([input]) =>
      String(input).includes("update-manifest."),
    ),
  ).toBe(true);
  const partial = new UpdateController({
    ...dependencies,
    findLatestRelease: async () => ({
      version: "0.4.0",
      assets: assets.slice(0, -1),
    }),
  });
  await expect(partial.check()).rejects.toThrow("缺失或重复");
  fixture.fetcher.mockImplementation(async () => new Response("corrupted"));
  const corrupt = new UpdateController({
    ...dependencies,
    findLatestRelease: async () => ({ version: "0.4.0", assets }),
  });
  await expect(corrupt.check()).rejects.toThrow();
  expect(corrupt.snapshot().downloadAvailable).toBe(false);
});

it("prohibits source changes during checking and never downloads a valid but older manifest", async () => {
  const fixture = fixtureManifest();
  const directory = await mkdtemp(join(tmpdir(), "matrix-protocol-"));
  directories.push(directory);
  let finish!: (value: {
    version: string;
    manifest: typeof fixture.manifest;
  }) => void;
  const controller = new UpdateController({
    currentVersion: "0.5.0",
    source: "manifest",
    keys: fixture.keys,
    target: { platform: "darwin", arch: "arm64", distribution: "app-zip" },
    cacheDirectory: directory,
    findLatestRelease: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = controller.check();
  expect(() => controller.resetSource()).toThrow("不能更改");
  finish({ version: "0.4.0", manifest: fixture.manifest });
  expect((await pending).status).toBe("up-to-date");
  await expect(controller.download()).rejects.toThrow();
  expect(() => controller.resetSource()).not.toThrow();
});
