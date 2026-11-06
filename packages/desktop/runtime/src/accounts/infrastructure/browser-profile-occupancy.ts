import { lstatSync } from "node:fs";
import { join } from "node:path";

/** Presence is deliberately conservative: dangling or stale links never authorize deletion. */
export function hasBrowserProfileSingleton(directory: string): boolean {
  // shortcut: Chromium POSIX markers; Windows external occupancy needs separate native verification before release.
  return ["SingletonLock", "SingletonCookie", "SingletonSocket"].some(
    (name) => {
      try {
        lstatSync(join(directory, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  );
}

export function assertBrowserProfileUnoccupied(directory: string): void {
  if (hasBrowserProfileSingleton(directory))
    throw new Error(
      "浏览器环境仍有占用标记，暂不能删除或替换。请先关闭该环境的浏览器；若浏览器已退出，请用原浏览器重新打开并正常关闭后重试。",
    );
}
