import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentAddressedPublicationAssetStore } from "../src/main/publishing/infrastructure/content-addressed-asset-store.js";
import {
  RemoteAssetDownloader,
  type RemotePublicationAsset,
} from "../src/main/publishing/infrastructure/remote-asset-downloader.js";

const temporaryRoots: string[] = [];
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(options?: {
  body?: Buffer;
  maxAssetBytes?: number;
  responses?: Response[];
}) {
  const root = await mkdtemp(join(tmpdir(), "matrix-assets-"));
  temporaryRoots.push(root);
  const responses = options?.responses ?? [new Response(options?.body ?? png)];
  const fetch = vi.fn(async () => responses.shift() ?? new Response(png));
  const assetStore = new ContentAddressedPublicationAssetStore(
    join(root, "assets"),
  );
  const diagnosticEvents: string[] = [];
  const downloader = new RemoteAssetDownloader({
    assetStore,
    stagingRoot: join(root, "staging"),
    fetch,
    maxAssetBytes: options?.maxAssetBytes,
    resolveHost: async () => ["203.0.113.10"],
    diagnostics: {
      start: () => ({
        traceId: "trace-1",
        bind: () => undefined,
        report: ({ event }) => diagnosticEvents.push(event),
        finish: ({ outcome }) => diagnosticEvents.push(`finish:${outcome}`),
      }),
    },
  });
  return { assetStore, diagnosticEvents, downloader, fetch, root };
}

function image(
  overrides: Partial<RemotePublicationAsset> = {},
): RemotePublicationAsset {
  return {
    url: "https://assets.example.test/image.png?temporary=secret",
    name: "image.png",
    mediaType: "image/png",
    role: "image",
    order: 0,
    sourceAssetId: "asset-1",
    ...overrides,
  };
}

describe("RemoteAssetDownloader", () => {
  it("archives a validated asset without retaining its signed URL", async () => {
    const { assetStore, diagnosticEvents, downloader } = await fixture();

    const [downloaded] = await downloader.download("request-1", [image()]);

    expect(downloaded).toMatchObject({
      created: true,
      mediaType: "image/png",
      size: png.length,
      sourceAssetId: "asset-1",
      sourceOrigin: "https://assets.example.test",
    });
    expect(downloaded?.localRelativePath).toMatch(
      /^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/,
    );
    expect(downloaded).not.toHaveProperty("statusCode");
    await expect(readFile(downloaded!.resourceReference)).resolves.toEqual(png);
    await expect(assetStore.list()).resolves.toEqual([
      {
        relativePath: downloaded!.localRelativePath,
        size: png.length,
      },
    ]);
    expect(JSON.stringify(downloaded)).not.toContain("temporary=secret");
    expect(diagnosticEvents).toEqual([
      "asset.download.started",
      "asset.download.item_started",
      "asset.download.item_completed",
      "finish:completed",
    ]);
  });

  it("deduplicates identical content across requests", async () => {
    const { downloader, root } = await fixture({
      responses: [new Response(png), new Response(png)],
    });

    const [first] = await downloader.download("request-1", [image()]);
    const [second] = await downloader.download("request-2", [image()]);

    expect(second?.resourceReference).toBe(first?.resourceReference);
    expect(second?.created).toBe(false);
    const files = await readdir(join(root, "assets"), { recursive: true });
    expect(files.filter((entry) => entry.endsWith(".png"))).toHaveLength(1);
  });

  it("uses the declared media type without inspecting the file signature", async () => {
    const { downloader } = await fixture();

    const [downloaded] = await downloader.download("request-1", [
      image({ name: "image.jpg", mediaType: "image/jpeg" }),
    ]);

    expect(downloaded).toMatchObject({
      mediaType: "image/jpeg",
      name: "image.jpg",
    });
    expect(downloaded?.localRelativePath).toMatch(/\.jpg$/);
  });

  it("rejects oversized media without leaving archived files", async () => {
    const oversized = await fixture({ maxAssetBytes: png.length - 1 });
    await expect(
      oversized.downloader.download("request-1", [image()]),
    ).rejects.toThrow("per-file size limit");

    await expect(readdir(join(oversized.root, "assets"))).rejects.toThrow();
  });

  it("rejects unsafe URLs and validates every redirect target", async () => {
    const direct = await fixture();
    await expect(
      direct.downloader.download("request-1", [
        image({ url: "http://assets.example.test/image.png" }),
      ]),
    ).rejects.toThrow("must use HTTPS");

    const redirected = await fixture({
      responses: [
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private.png" },
        }),
      ],
    });
    await expect(
      redirected.downloader.download("request-2", [image()]),
    ).rejects.toThrow("private address");
  });
});
