import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  ApplicationUpdateCheckResult,
  ApplicationUpdateState,
} from "../../bridge/contracts.js";
import {
  isNewerVersion,
  type ApplicationRelease,
  type ApplicationUpdateSource,
} from "./application-update.js";
import {
  selectUpdateArtifact,
  verifyUpdateManifest,
  type UpdateArtifact,
} from "./update-manifest.js";
import {
  fetchUpdateAsset,
  readBoundedResponse,
  validateUpdateUrl,
} from "./update-network.js";

export interface UpdateControllerDependencies {
  currentVersion: string;
  source: ApplicationUpdateSource;
  target: { platform: string; arch: string; distribution: string };
  keys: Readonly<Record<string, string>>;
  cacheDirectory: string;
  findLatestRelease(): Promise<ApplicationRelease>;
  fetcher?: typeof fetch;
  sourceIdentity?: string;
  /** Injectable short limits in tests; production has a bounded overall deadline. */
  downloadTimeoutMs?: number;
  onChange?(state: ApplicationUpdateState): void;
}

interface SelectedDownload {
  artifact: UpdateArtifact;
  url: string;
  file: string;
  policy: ApplicationUpdateSource;
}

export class UpdateController {
  private state: ApplicationUpdateState;
  private selected: SelectedDownload | undefined;
  private checkInFlight: Promise<ApplicationUpdateCheckResult> | undefined;
  private downloadInFlight: Promise<void> | undefined;
  private downloadAbort: AbortController | undefined;

  constructor(private readonly dependencies: UpdateControllerDependencies) {
    this.state = {
      revision: 0,
      phase: "idle",
      currentVersion: dependencies.currentVersion,
      downloadAvailable: false,
      receivedBytes: 0,
      totalBytes: 0,
    };
  }

  snapshot(): ApplicationUpdateState {
    return structuredClone(this.state);
  }

  signedDownloadUrl(version: string): string | undefined {
    return this.state.latestVersion === version
      ? this.selected?.url
      : undefined;
  }

  assertCanChangeSource(): void {
    if (this.checkInFlight || this.downloadInFlight)
      throw new Error("检查、下载或校验期间不能更改更新源");
  }

  resetSource(): void {
    this.assertCanChangeSource();
    this.selected = undefined;
    this.change({
      phase: "idle",
      latestVersion: undefined,
      taskId: undefined,
      error: undefined,
      message: undefined,
      downloadAvailable: false,
      receivedBytes: 0,
      totalBytes: 0,
    });
  }

  private change(patch: Partial<ApplicationUpdateState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.dependencies.onChange?.(this.snapshot());
  }

  check(): Promise<ApplicationUpdateCheckResult> {
    if (this.checkInFlight) return this.checkInFlight;
    if (this.downloadInFlight || this.state.phase === "ready") {
      return Promise.reject(
        new Error("请先完成当前下载的手动安装；下载中不能重新检查"),
      );
    }
    this.selected = undefined;
    this.change({
      phase: "checking",
      latestVersion: undefined,
      taskId: undefined,
      error: undefined,
      message: undefined,
      downloadAvailable: false,
      receivedBytes: 0,
      totalBytes: 0,
    });
    this.checkInFlight = this.performCheck()
      .catch((error: unknown) => {
        this.change({
          phase: "failed",
          error: { stage: "check", retryable: true, message: userError(error) },
        });
        throw error;
      })
      .finally(() => {
        this.checkInFlight = undefined;
      });
    return this.checkInFlight;
  }

  private async performCheck(): Promise<ApplicationUpdateCheckResult> {
    const { currentVersion, source, keys, target } = this.dependencies;
    const release = await this.dependencies.findLatestRelease();
    if (!isNewerVersion(release.version, currentVersion)) {
      this.change({ phase: "up-to-date" });
      return { status: "up-to-date", currentVersion };
    }
    this.change({ latestVersion: release.version });
    const manifests = (release.assets ?? []).filter(
      (asset) => asset.name === "update-manifest.json",
    );
    const signatures = (release.assets ?? []).filter(
      (asset) => asset.name === "update-manifest.sig",
    );
    if (
      !release.manifest &&
      manifests.length === 0 &&
      signatures.length === 0
    ) {
      this.change({
        phase: "available",
        message: "此版本未提供可信更新清单，请从下载页手动更新。",
      });
    } else if (
      !release.manifest &&
      (manifests.length !== 1 || signatures.length !== 1)
    ) {
      throw new Error("更新清单附件缺失或重复，不能在应用内下载");
    } else if (Object.keys(keys).length === 0) {
      this.change({
        phase: "available",
        message: "当前构建未配置更新公钥，请从下载页手动更新。",
      });
    } else {
      const signal = AbortSignal.timeout(30_000);
      const load = async (url: string, limit: number) =>
        readBoundedResponse(
          await fetchUpdateAsset(
            url,
            source,
            signal,
            this.dependencies.fetcher,
          ),
          limit,
        );
      const [manifestBytes, signatureBytes] = release.manifest
        ? [new Uint8Array(), new Uint8Array()]
        : await Promise.all([
            load(manifests[0]!.url, 64 * 1024),
            load(signatures[0]!.url, 4 * 1024),
          ]);
      const manifest =
        release.manifest ??
        verifyUpdateManifest(manifestBytes, signatureBytes, keys, {
          version: release.version,
        });
      // Download locations come only from the verified manifest.
      for (const artifact of manifest.artifacts) {
        validateUpdateUrl(artifact.url, "manifest");
      }
      const artifact = selectUpdateArtifact(manifest, target);
      if (!artifact) {
        this.change({
          phase: "available",
          message: "此平台或发行类型暂不支持应用内下载，请使用下载页。",
        });
      } else {
        const identity = createHash("sha256")
          .update(this.dependencies.sourceIdentity ?? source)
          .digest("hex");
        const scope = `${identity}-${manifest.appId}-${release.version}-${artifact.platform}-${artifact.arch}-${artifact.distribution}-${artifact.sha256}`;
        const file = join(
          this.dependencies.cacheDirectory,
          scope,
          artifact.assetName,
        );
        this.selected = {
          artifact,
          file,
          policy: "manifest",
          url: artifact.url,
        };
        const cached = await this.verifyFile(file, artifact).catch(() => false);
        this.change({
          phase: cached ? "ready" : "available",
          downloadAvailable: true,
          totalBytes: artifact.size,
          receivedBytes: cached ? artifact.size : 0,
          message: cached
            ? "下载已校验。此阶段请打开文件位置，退出应用后手动安装。"
            : undefined,
        });
      }
    }
    return {
      status: "update-available",
      currentVersion,
      latestVersion: release.version,
    };
  }

  download(): Promise<void> {
    if (this.downloadInFlight) return this.downloadInFlight;
    if (this.checkInFlight || !this.selected)
      return Promise.reject(new Error("请先检查并确认存在可信更新包"));
    if (this.state.phase === "ready") return Promise.resolve();
    const selected = this.selected;
    const taskId = randomUUID();
    this.downloadAbort = new AbortController();
    const cancellation = this.downloadAbort.signal;
    const signal = AbortSignal.any([
      cancellation,
      AbortSignal.timeout(this.dependencies.downloadTimeoutMs ?? 15 * 60_000),
    ]);
    this.change({
      phase: "downloading",
      taskId,
      receivedBytes: 0,
      error: undefined,
      message: undefined,
    });
    this.downloadInFlight = this.performDownload(selected, taskId, signal)
      .catch((error: unknown) => {
        if (cancellation.aborted) {
          this.change({
            phase: "available",
            receivedBytes: 0,
            message: "下载已取消，可以重新下载。",
          });
        } else {
          this.change({
            phase: "failed",
            error: {
              stage: "download",
              retryable: true,
              message: userError(error),
            },
          });
          throw error;
        }
      })
      .finally(() => {
        this.downloadInFlight = undefined;
        this.downloadAbort = undefined;
      });
    return this.downloadInFlight;
  }

  async cancel(): Promise<void> {
    this.downloadAbort?.abort();
    await this.downloadInFlight?.catch(() => undefined);
  }

  private async performDownload(
    selected: SelectedDownload,
    taskId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { artifact, file, url } = selected;
    const temporary = `${file}.${taskId}.part`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      const response = await fetchUpdateAsset(
        url,
        selected.policy,
        signal,
        this.dependencies.fetcher,
      );
      if (!response.body) throw new Error("更新包没有内容");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== artifact.size) {
        await response.body.cancel();
        throw new Error("更新包大小与清单不一致");
      }
      const hash = createHash("sha256");
      let received = 0;
      let lastProgress = 0;
      const reader = response.body.getReader();
      const controller = this;
      const chunks = async function* () {
        try {
          for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > artifact.size)
              throw new Error("更新包超过清单声明的大小");
            hash.update(value);
            if (Date.now() - lastProgress >= 150) {
              lastProgress = Date.now();
              controller.change({ receivedBytes: received });
            }
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      };
      await pipeline(
        Readable.from(chunks()),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      signal.throwIfAborted();
      this.change({ phase: "verifying", receivedBytes: received });
      if (received !== artifact.size || hash.digest("hex") !== artifact.sha256)
        throw new Error("更新包大小或 SHA-256 校验失败，请重新下载");
      // Atomic cache promotion only after validation; a .part is never exposed.
      await rename(temporary, file);
      this.change({
        phase: "ready",
        message: "下载已校验。此阶段请打开文件位置，退出应用后手动安装。",
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async verifyFile(
    file: string,
    artifact: UpdateArtifact,
  ): Promise<boolean> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size)
      return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === artifact.sha256;
  }

  async verifiedDownloadedFile(): Promise<string> {
    if (this.state.phase !== "ready" || !this.selected)
      throw new Error("尚无已校验的更新包");
    if (
      !(await this.verifyFile(this.selected.file, this.selected.artifact).catch(
        () => false,
      ))
    ) {
      this.change({
        phase: "failed",
        receivedBytes: 0,
        error: {
          stage: "download",
          retryable: true,
          message: "缓存包已变动，请重新下载",
        },
      });
      throw new Error("缓存包已变动，请重新下载");
    }
    return this.selected.file;
  }
}

function userError(error: unknown): string {
  if (
    error instanceof Error &&
    /TimeoutError|AbortError|fetch failed/i.test(
      `${error.name} ${error.message}`,
    )
  ) {
    return "连接更新源超时或中断，请稍后重试；也可以打开下载页。";
  }
  return error instanceof Error ? error.message : "更新操作失败，请重试";
}
