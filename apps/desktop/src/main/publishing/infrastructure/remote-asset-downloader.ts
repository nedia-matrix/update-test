import { createHash } from "node:crypto";
import { open, mkdtemp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  DownloadedPublicationAsset,
  RemotePublicationAsset,
} from "@nedia-matrix/publishing";
import type { DiagnosticTraceService } from "@nedia-matrix/diagnostics";

import type { ContentAddressedPublicationAssetStore } from "./content-addressed-asset-store.js";

import {
  publicHttpsFetch,
  validatePublicHttpsUrl,
} from "../../network/public-https-fetch.js";

interface RemoteAssetDownloaderOptions {
  assetStore: ContentAddressedPublicationAssetStore;
  stagingRoot: string;
  fetch?: typeof globalThis.fetch;
  maxAssetBytes?: number;
  maxTaskBytes?: number;
  timeoutMs?: number;
  now?: () => Date;
  diagnostics?: Pick<DiagnosticTraceService, "start">;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class RemoteAssetDownloader {
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxAssetBytes: number;
  private readonly maxTaskBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: RemoteAssetDownloaderOptions) {
    this.fetch = options.fetch ?? publicHttpsFetch;
    this.maxAssetBytes = options.maxAssetBytes ?? 1024 * 1024 * 1024;
    this.maxTaskBytes = options.maxTaskBytes ?? 2 * 1024 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 120_000;
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
      // Shared files may already belong to another task; only private staging is rolled back.
      throw error;
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      const fetched = await this.fetchFollowingRedirects(
        asset.url,
        controller.signal,
      );
      response = fetched.response;
      if (!response.ok || !response.body) {
        throw new Error(
          `Remote asset download failed with HTTP ${response.status}`,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.maxAssetBytes
      )
        throw new Error("Remote asset exceeds the per-file size limit");

      const file = await open(stagedPath, "wx");
      const reader = response.body.getReader();
      const abort = () => {
        void reader.cancel(controller.signal.reason).catch(() => {});
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      const hash = createHash("sha256");
      let size = 0;
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const { value, done } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          const chunk = Buffer.from(value);
          size += chunk.length;
          if (size > this.maxAssetBytes)
            throw new Error("Remote asset exceeds the per-file size limit");
          hash.update(chunk);
          await file.write(chunk);
        }
      } finally {
        controller.signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await file.close();
      }
      return {
        hash: hash.digest("hex"),
        mediaType: asset.mediaType,
        size,
        sourceOrigin: fetched.sourceOrigin,
        statusCode: response.status,
      };
    } finally {
      clearTimeout(timeout);
      await response?.body?.cancel().catch(() => {});
    }
  }

  private async fetchFollowingRedirects(
    value: string,
    signal: AbortSignal,
  ): Promise<{ response: Response; sourceOrigin: string }> {
    let url = validatePublicHttpsUrl(value);
    const sourceOrigin = url.origin;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      signal.throwIfAborted();
      const response = await this.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
      });
      if (!redirectStatuses.has(response.status))
        return { response, sourceOrigin };
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new Error("Too many asset redirects");
      url = validatePublicHttpsUrl(new URL(location, url).href);
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
