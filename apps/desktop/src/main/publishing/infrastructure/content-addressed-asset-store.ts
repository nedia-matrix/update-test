import { link, lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type { StoredPublicationAsset } from "@nedia-matrix/publishing";

const extensionsByMediaType: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

export interface CommittedPublicationAsset {
  absolutePath: string;
  created: boolean;
  relativePath: string;
}

export class ContentAddressedPublicationAssetStore {
  constructor(private readonly root: string) {}

  async commit(input: {
    hash: string;
    mediaType: string;
    stagedPath: string;
  }): Promise<CommittedPublicationAsset> {
    if (!/^[a-f0-9]{64}$/.test(input.hash)) {
      throw new TypeError("Invalid SHA-256 hash");
    }
    const extension = extensionsByMediaType[input.mediaType];
    if (!extension) throw new TypeError("Unsupported archived media type");
    const relativePath = posix.join(
      "sha256",
      input.hash.slice(0, 2),
      `${input.hash}.${extension}`,
    );
    const absolutePath = join(this.root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await link(input.stagedPath, absolutePath);
      await unlink(input.stagedPath);
      return { absolutePath, relativePath, created: true };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      await unlink(input.stagedPath);
      return { absolutePath, relativePath, created: false };
    }
  }

  async remove(relativePath: string): Promise<void> {
    if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/.test(relativePath)) {
      throw new TypeError("Invalid archived asset path");
    }
    try {
      const absolutePath = join(this.root, relativePath);
      await unlink(absolutePath);
      await rmdir(dirname(absolutePath)).catch((error: unknown) => {
        if (!isDirectoryNotEmptyError(error) && !isFileMissingError(error)) {
          throw error;
        }
      });
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
    }
  }

  async resolvePath(relativePath: string): Promise<string | undefined> {
    if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/.test(relativePath))
      return undefined;
    const absolutePath = join(this.root, relativePath);
    try {
      const metadata = await lstat(absolutePath);
      return metadata.isFile() && !metadata.isSymbolicLink()
        ? absolutePath
        : undefined;
    } catch (error) {
      if (isFileMissingError(error)) return undefined;
      throw error;
    }
  }

  async list(): Promise<StoredPublicationAsset[]> {
    const shaRoot = join(this.root, "sha256");
    let prefixes;
    try {
      prefixes = await readdir(shaRoot, { withFileTypes: true });
    } catch (error) {
      if (isFileMissingError(error)) return [];
      throw error;
    }
    const assets: StoredPublicationAsset[] = [];
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const prefixRoot = join(shaRoot, prefix.name);
      for (const entry of await readdir(prefixRoot, { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.([a-z0-9]+)$/.exec(entry.name);
        if (
          !entry.isFile() ||
          !match ||
          match[1]?.slice(0, 2) !== prefix.name
        ) {
          continue;
        }
        const metadata = await lstat(join(prefixRoot, entry.name));
        if (!metadata.isFile()) continue;
        assets.push({
          relativePath: posix.join("sha256", prefix.name, entry.name),
          size: metadata.size,
        });
      }
    }
    return assets.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isDirectoryNotEmptyError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && error.code === "ENOTEMPTY"
  );
}
