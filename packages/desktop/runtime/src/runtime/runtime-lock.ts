import { mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export class RuntimeInUseError extends Error {
  constructor() {
    super("此数据目录正在使用中，请先完全退出另一个桌面版本，再重新启动。");
    this.name = "RuntimeInUseError";
  }
}

// The native descriptor stays open until process termination, including on
// startup failure. Never expose an early release or unlink the lock file.
export function acquireRuntimeLock(
  directory: string,
  nativeDirectory: string,
): string {
  mkdirSync(directory, { recursive: true });
  const canonical = realpathSync.native(directory);
  const require = createRequire(join(nativeDirectory, "loader.cjs"));
  const binding = require(join(nativeDirectory, "runtime-lock.node")) as {
    acquire(path: string): boolean;
  };
  if (!binding.acquire(join(canonical, ".nedia-runtime.lock"))) {
    throw new RuntimeInUseError();
  }
  return canonical;
}
