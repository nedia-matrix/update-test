import { createHash } from "node:crypto";
import { open, mkdtemp, mkdir, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { lookup } from "node:dns/promises";

import type {
  DownloadedPublicationAsset,
  PublicationAssetRole,
  RemotePublicationAsset,
} from "@nedia-matrix/publishing";
import type { DiagnosticTraceService } from "@nedia-matrix/diagnostics";

import type { ContentAddressedPublicationAssetStore } from "./content-addressed-asset-store.js";

interface RemoteAssetDownloaderOptions {
  assetStore: ContentAddressedPublicationAssetStore;
  stagingRoot: string;
  fetch?: typeof globalThis.fetch;
  maxAssetBytes?: number;
  maxTaskBytes?: number;
  timeoutMs?: number;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  now?: () => Date;
  diagnostics?: Pick<DiagnosticTraceService, "start">;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class RemoteAssetDownloader {
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxAssetBytes: number;
  private readonly maxTaskBytes: number;
  private readonly timeoutMs: number;
  private readonly resolveHost: (
    hostname: string,
  ) => Promise<readonly string[]>;

  constructor(private readonly options: RemoteAssetDownloaderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxAssetBytes = options.maxAssetBytes ?? 1024 * 1024 * 1024;
    this.maxTaskBytes = options.maxTaskBytes ?? 2 * 1024 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.resolveHost = options.resolveHost ?? resolvePublicAddresses;
  }

  async download(
    requestId: string,
    assets: readonly RemotePublicationAsset[],
  ): Promise<DownloadedPublicationAsset[]> {
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(requestId)) {
      throw new TypeError("Invalid asset download request id");
    }
    if (assets.length === 0)
      throw new TypeError("At least one asset is required");
    const trace = this.options.diagnostics?.start({
      operation: "asset.download",
      requestId,
    });
    trace?.report({
      component: "network",
      event: "asset.download.started",
      details: { assetCount: assets.length },
    });
    await mkdir(this.options.stagingRoot, { recursive: true });
    const stagingDirectory = await mkdtemp(
      join(this.options.stagingRoot, `${requestId}-`),
    );
    const newlyCreatedPaths: string[] = [];
    const downloaded: DownloadedPublicationAsset[] = [];
    let taskBytes = 0;
    try {
      for (const [index, asset] of assets.entries()) {
        validateAsset(asset);
        trace?.report({
          component: "network",
          event: "asset.download.item_started",
          details: { assetIndex: index, attempt: 1, url: asset.url },
        });
        const stagedPath = join(stagingDirectory, `${index}.download`);
        const staged = await this.downloadOne(asset, stagedPath);
        taskBytes += staged.size;
        if (taskBytes > this.maxTaskBytes) {
          throw new Error("Remote assets exceed the task size limit");
        }
        const committed = await this.options.assetStore.commit({
          stagedPath,
          hash: staged.hash,
          mediaType: staged.mediaType,
        });
        if (committed.created) newlyCreatedPaths.push(committed.relativePath);
        const { statusCode, ...assetMetadata } = staged;
        downloaded.push({
          ...assetMetadata,
          created: committed.created,
          resourceReference: committed.absolutePath,
          localRelativePath: committed.relativePath,
          name: asset.name,
          role: asset.role,
          order: asset.order,
          sourceAssetId: asset.sourceAssetId ?? null,
          downloadedAt: (
            this.options.now ?? (() => new Date())
          )().toISOString(),
        });
        trace?.report({
          component: "network",
          event: "asset.download.item_completed",
          details: {
            assetIndex: index,
            byteSize: staged.size,
            mimeType: staged.mediaType,
            statusCode,
            stage: "sha256_verified_and_stored",
          },
        });
      }
      trace?.finish({ outcome: "completed" });
      return downloaded;
    } catch (error) {
      trace?.report({
        component: "network",
        event: "asset.download.failed",
        level: "error",
        details: {
          code: classifyDownloadError(error),
          errorName: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error ? error.message : "Asset download failed",
          retryable: isRetryableDownloadError(error),
        },
      });
      trace?.finish({
        outcome: "failed",
        message:
          error instanceof Error ? error.message : "Asset download failed",
      });
      await Promise.all(
        newlyCreatedPaths.map((relativePath) =>
          this.options.assetStore.remove(relativePath),
        ),
      );
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async discardUnreferenced(
    assets: readonly DownloadedPublicationAsset[],
    referencedRelativePaths: ReadonlySet<string>,
  ): Promise<void> {
    const unreferenced = new Set(
      assets
        .filter(({ created }) => created)
        .map(({ localRelativePath }) => localRelativePath)
        .filter((relativePath) => !referencedRelativePaths.has(relativePath)),
    );
    await Promise.all(
      [...unreferenced].map((relativePath) =>
        this.options.assetStore.remove(relativePath),
      ),
    );
  }

  private async downloadOne(
    asset: RemotePublicationAsset,
    stagedPath: string,
  ): Promise<{
    hash: string;
    mediaType: RemotePublicationAsset["mediaType"];
    size: number;
    sourceOrigin: string;
    statusCode: number;
  }> {
    const { response, sourceOrigin } = await this.fetchFollowingRedirects(
      asset.url,
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `Remote asset download failed with HTTP ${response.status}`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxAssetBytes
    ) {
      throw new Error("Remote asset exceeds the per-file size limit");
    }

    const file = await open(stagedPath, "wx");
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > this.maxAssetBytes) {
          throw new Error("Remote asset exceeds the per-file size limit");
        }
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    return {
      hash: hash.digest("hex"),
      mediaType: asset.mediaType,
      size,
      sourceOrigin,
      statusCode: response.status,
    };
  }

  private async fetchFollowingRedirects(
    value: string,
  ): Promise<{ response: Response; sourceOrigin: string }> {
    let url = new URL(value);
    const sourceOrigin = url.origin;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertSafeRemoteUrl(url, this.resolveHost);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!redirectStatuses.has(response.status))
        return { response, sourceOrigin };
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new Error("Too many asset redirects");
      url = new URL(location, url);
    }
    throw new Error("Too many asset redirects");
  }
}

function classifyDownloadError(error: unknown): string {
  if (error instanceof TypeError) return "ASSET_REQUEST_REJECTED";
  if (error instanceof DOMException && error.name === "AbortError")
    return "ASSET_DOWNLOAD_TIMEOUT";
  if (error instanceof Error && error.message.includes("size limit"))
    return "ASSET_SIZE_LIMIT";
  if (error instanceof Error && error.message.includes("HTTP"))
    return "ASSET_HTTP_ERROR";
  return "ASSET_DOWNLOAD_FAILED";
}

function isRetryableDownloadError(error: unknown): boolean {
  const code = classifyDownloadError(error);
  return code === "ASSET_DOWNLOAD_TIMEOUT" || code === "ASSET_HTTP_ERROR";
}

function validateAsset(asset: RemotePublicationAsset): void {
  if (
    !asset.name ||
    asset.name.length > 255 ||
    basename(asset.name) !== asset.name ||
    /[\u0000-\u001f\u007f]/.test(asset.name)
  ) {
    throw new TypeError("Invalid remote asset name");
  }
  if (!Number.isInteger(asset.order) || asset.order < 0) {
    throw new TypeError("Invalid remote asset order");
  }
}

async function assertSafeRemoteUrl(
  url: URL,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("Remote asset URL must use HTTPS without credentials");
  }
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new TypeError("Remote asset URL resolves to a private address");
  }
}

async function resolvePublicAddresses(
  hostname: string,
): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
    if (mappedIpv4) return isPrivateAddress(mappedIpv4);
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return true;
  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}
