import { randomUUID } from "node:crypto";
import {
  fingerprintBrowserAsset,
  fingerprintBrowserVersion,
  FingerprintInstallError,
  installFingerprintBrowser,
  readFingerprintInstallation,
  recoverFingerprintInstallation,
  verifyFingerprintBrowser,
} from "@nedia-matrix/automation-playwright";
import type {
  CancelFingerprintBrowserInstallRequest,
  FingerprintBrowserStatus,
  InstallFingerprintBrowserRequest,
} from "../../bridge/fingerprint-browser.js";

interface Dependencies {
  fetch: typeof fetch;
  install: typeof installFingerprintBrowser;
  read: typeof readFingerprintInstallation;
  recover: typeof recoverFingerprintInstallation;
  verify: typeof verifyFingerprintBrowser;
  acquireMaintenance(): () => void;
  enableForNewAccounts?(): void;
}
const messages: Record<
  NonNullable<FingerprintBrowserStatus["error"]>["code"],
  string
> = {
  unsupported: "当前系统暂不支持定制浏览器（暂不支持 Intel Mac）",
  busy: "浏览器正在使用或启动中，请关闭相关浏览器窗口并结束操作后重试",
  network: "定制浏览器下载失败或超时，请检查网络后重试",
  checksum: "定制浏览器安装包校验失败，请重新下载",
  archive: "定制浏览器安装包无法解压，请重新下载后重试",
  verification: "定制浏览器暂不可用，请安装或修复",
  filesystem: "无法读写定制浏览器安装目录，请检查本机存储后重试",
  cleanup: "安装临时文件清理失败，请退出并重新启动应用以恢复",
  preferences: "浏览器已安装，但保存新账号默认环境失败，请重试",
};
export class FingerprintBrowserService {
  private state: FingerprintBrowserStatus = {
    revision: 0,
    version: fingerprintBrowserVersion,
    supported: !!fingerprintBrowserAsset(),
    available: false,
    phase: "checking",
    receivedBytes: 0,
  };
  private readonly listeners = new Set<
    (state: FingerprintBrowserStatus) => void
  >();
  private task:
    | {
        id: string;
        controller: AbortController;
        done: Promise<void>;
        enableForNewAccounts: boolean;
      }
    | undefined;
  private initialization: Promise<void> | undefined;
  private stopping = false;
  private readonly validations = new Set<Promise<void>>();
  private readonly lifecycleController = new AbortController();
  private readonly dependencies: Dependencies;

  constructor(
    private readonly root: string,
    acquireMaintenance: () => () => void,
    dependencies: Partial<Dependencies> = {},
  ) {
    this.dependencies = {
      fetch: globalThis.fetch,
      install: installFingerprintBrowser,
      read: readFingerprintInstallation,
      recover: recoverFingerprintInstallation,
      verify: verifyFingerprintBrowser,
      acquireMaintenance,
      ...dependencies,
    };
  }
  snapshot(): FingerprintBrowserStatus {
    return structuredClone(this.state);
  }
  subscribe(listener: (state: FingerprintBrowserStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<FingerprintBrowserStatus>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* Renderer lifecycle does not own installation. */
      }
    }
  }
  private fail(code: NonNullable<FingerprintBrowserStatus["error"]>["code"]) {
    this.publish({ phase: "failed", error: { code, message: messages[code] } });
  }
  initialize(): Promise<void> {
    return (this.initialization ??= (async () => {
      if (!this.state.supported) {
        this.fail("unsupported");
        return;
      }
      let release: (() => void) | undefined;
      try {
        release = this.dependencies.acquireMaintenance();
      } catch {
        this.fail("busy");
        return;
      }
      try {
        await this.dependencies.recover(this.root);
        const executable = await this.dependencies.read(this.root);
        if (!executable) {
          this.publish({ phase: "missing" });
          return;
        }
        this.publish({ phase: "verifying" });
        try {
          await this.dependencies.verify(
            executable,
            this.lifecycleController.signal,
          );
        } catch {
          this.fail("verification");
          return;
        }
        this.publish({ phase: "ready", available: true });
      } catch (error) {
        this.fail(
          error instanceof FingerprintInstallError ? error.code : "filesystem",
        );
      } finally {
        release?.();
      }
    })());
  }
  async getStatus(): Promise<FingerprintBrowserStatus> {
    await this.initialize();
    return this.snapshot();
  }

  async assertReady(): Promise<void> {
    await this.initialize();
    if (this.stopping || this.task || !this.state.supported)
      throw new Error("定制浏览器正在准备或暂不可用，请稍后重试");
    const validation = (async () => {
      try {
        const executable = await this.dependencies.read(this.root);
        if (!executable) throw new Error("missing");
        await this.dependencies.verify(
          executable,
          this.lifecycleController.signal,
        );
        this.lifecycleController.signal.throwIfAborted();
      } catch {
        throw new Error("定制浏览器暂不可用，请前往应用设置完成配置。");
      }
    })();
    this.validations.add(validation);
    try {
      await validation;
      if (this.state.error?.code === "preferences") {
        this.publish({ phase: "ready", error: undefined });
      }
    } finally {
      this.validations.delete(validation);
    }
  }

  async install(
    request: InstallFingerprintBrowserRequest = {},
  ): Promise<FingerprintBrowserStatus> {
    await this.initialize();
    if (this.stopping) throw new Error("应用正在退出");
    if (this.task) {
      if (request.enableForNewAccounts) this.task.enableForNewAccounts = true;
      return this.snapshot();
    }
    if (this.validations.size) {
      this.fail("busy");
      return this.snapshot();
    }
    if (!this.state.supported) {
      this.fail("unsupported");
      return this.snapshot();
    }
    let release: () => void;
    try {
      release = this.dependencies.acquireMaintenance();
    } catch {
      this.fail("busy");
      return this.snapshot();
    }
    const id = randomUUID();
    const controller = new AbortController();
    const task = {
      id,
      controller,
      done: Promise.resolve(),
      enableForNewAccounts: request.enableForNewAccounts === true,
    };
    this.task = task;
    task.done = this.run(task, release);
    this.publish({
      taskId: id,
      phase: "downloading",
      receivedBytes: 0,
      totalBytes: undefined,
      error: undefined,
    });
    return this.snapshot();
  }
  private async run(
    task: NonNullable<FingerprintBrowserService["task"]>,
    release: () => void,
  ): Promise<void> {
    let terminal: "ready" | "cancelled" | "failed" = "ready";
    let code:
      NonNullable<FingerprintBrowserStatus["error"]>["code"] | undefined;
    let lastProgressTime = 0;
    let lastPhase = "";
    let available = this.state.available;
    try {
      await this.dependencies.recover(this.root);
      task.controller.signal.throwIfAborted();
      await this.dependencies.install({
        root: this.root,
        signal: task.controller.signal,
        dependencies: { fetch: this.dependencies.fetch },
        onProgress: (progress) => {
          if (this.task !== task || task.controller.signal.aborted) return;
          // Bound IPC traffic while preserving phase changes and final byte counts.
          const now = Date.now();
          if (progress.phase === lastPhase && now - lastProgressTime < 100)
            return;
          lastPhase = progress.phase;
          lastProgressTime = now;
          this.publish(progress);
        },
      });
      available = true;
      if (task.enableForNewAccounts) {
        try {
          if (!this.dependencies.enableForNewAccounts)
            throw new Error("Browser preferences are not configured");
          this.dependencies.enableForNewAccounts();
        } catch {
          terminal = "failed";
          code = "preferences";
        }
      }
    } catch (error) {
      if (
        error instanceof FingerprintInstallError &&
        error.code === "cleanup"
      ) {
        terminal = "failed";
        code = "cleanup";
      } else if (task.controller.signal.aborted) terminal = "cancelled";
      else {
        terminal = "failed";
        code =
          error instanceof FingerprintInstallError ? error.code : "filesystem";
      }
    } finally {
      if (this.state.phase === "publishing") {
        try {
          available = !!(await this.dependencies.read(this.root));
        } catch {
          available = false;
        }
      }
      try {
        release();
      } finally {
        if (this.task === task) {
          this.task = undefined;
          this.publish({
            phase: terminal,
            available,
            ...(code
              ? { error: { code, message: messages[code] } }
              : { error: undefined }),
          });
        }
      }
    }
  }
  async cancel(
    request: CancelFingerprintBrowserInstallRequest,
  ): Promise<FingerprintBrowserStatus> {
    if (!request || typeof request.taskId !== "string" || !request.taskId)
      throw new TypeError("Invalid fingerprint installation task");
    const task = this.task;
    if (!task || task.id !== request.taskId) return this.snapshot();
    if (!task.controller.signal.aborted && this.state.phase !== "publishing") {
      this.publish({ phase: "cancelling" });
      task.controller.abort();
    }
    await task.done;
    return this.snapshot();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.lifecycleController.abort();
    await this.initialize();
    if (this.task) await this.cancel({ taskId: this.task.id });
    await Promise.allSettled(this.validations);
  }
}
