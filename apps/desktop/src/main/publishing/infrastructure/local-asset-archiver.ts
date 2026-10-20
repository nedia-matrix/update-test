import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LocalMediaResource } from "@nedia-matrix/publishing";
import type { ContentAddressedPublicationAssetStore } from "./content-addressed-asset-store.js";

const mediaTypes: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
};

export class LocalAssetArchiver {
  constructor(
    private readonly assetStore: ContentAddressedPublicationAssetStore,
    private readonly stagingRoot: string,
  ) {}

  async archive(
    resources: readonly LocalMediaResource[],
  ): Promise<LocalMediaResource[]> {
    for (const resource of resources) {
      if (!mediaTypes[resource.extension.toLowerCase()])
        throw new TypeError("Selected media format is not supported");
    }
    await mkdir(this.stagingRoot, { recursive: true });
    const staging = await mkdtemp(join(this.stagingRoot, "local-media-"));
    const archived: LocalMediaResource[] = [];
    try {
      for (const [index, resource] of resources.entries()) {
        const hash = createHash("sha256");
        let size = 0;
        const stagedPath = join(staging, String(index));
        // Copy, rather than link, so later edits to the selected original cannot alter the archive.
        await pipeline(
          createReadStream(resource.reference),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              size += chunk.length;
              callback(null, chunk);
            },
          }),
          createWriteStream(stagedPath, { flags: "wx" }),
        );
        const digest = hash.digest("hex");
        const mediaType = mediaTypes[resource.extension.toLowerCase()]!;
        const committed = await this.assetStore.commit({
          hash: digest,
          mediaType,
          stagedPath,
        });
        archived.push({
          ...resource,
          size,
          hash: digest,
          mediaType,
          reference: committed.absolutePath,
          localRelativePath: committed.relativePath,
        });
      }
      return archived;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
