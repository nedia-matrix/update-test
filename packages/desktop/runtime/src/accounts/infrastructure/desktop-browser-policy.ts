import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  browserProfileDirectory,
  fingerprintBrowserVersion,
  createBrowserProfileId,
  initializeBrowserRuntime,
  verifyFingerprintBrowser,
  readStoredBrowserRuntime,
  type BrowserRuntimeConfiguration,
} from "@nedia-matrix/automation-playwright";
import type { PreferencesStore } from "../../preferences/preferences-store.js";

// Desktop assets are distinct from the CLI cache and externally pinned binaries.
export const desktopFingerprintBrowserVersion = fingerprintBrowserVersion;

export class DesktopBrowserPolicy {
  constructor(
    private readonly userDataDirectory: string,
    private readonly preferences: PreferencesStore,
  ) {}

  fingerprintRuntime(): BrowserRuntimeConfiguration {
    const root = join(
      this.userDataDirectory,
      "browsers",
      desktopFingerprintBrowserVersion,
    );
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(join(root, "installed.json"), "utf8"),
      );
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !("version" in manifest) ||
        manifest.version !== desktopFingerprintBrowserVersion ||
        !("executable" in manifest) ||
        typeof manifest.executable !== "string" ||
        !isAbsolute(manifest.executable)
      )
        throw new Error("Invalid installation manifest");
      const executable = realpathSync(manifest.executable);
      const path = relative(realpathSync(root), executable);
      if (
        !path ||
        isAbsolute(path) ||
        path.split(/[\\/]/).includes("..") ||
        !statSync(executable).isFile()
      )
        throw new Error("Browser executable outside managed installation");
      return { provider: "fingerprint", executablePath: executable };
    } catch {
      throw new Error("定制浏览器暂不可用，请前往应用设置完成配置。");
    }
  }

  async assertFingerprintReady(): Promise<void> {
    const runtime = this.fingerprintRuntime();
    try {
      await verifyFingerprintBrowser(runtime.executablePath!);
    } catch {
      throw new Error("定制浏览器暂不可用，请前往应用设置完成配置。");
    }
  }

  async describeProfile(profileId: string): Promise<{
    provider: "system" | "fingerprint" | null;
    externalKernel: boolean;
    version?: string;
  }> {
    try {
      const runtime = await readStoredBrowserRuntime(
        browserProfileDirectory(
          join(this.userDataDirectory, "browser-profiles"),
          profileId,
        ),
      );
      if (!runtime || runtime.provider === "system")
        return { provider: "system", externalKernel: false };
      const canonical = (path: string) => {
        try {
          return realpathSync(path);
        } catch {
          return resolve(path);
        }
      };
      const managedRoot = canonical(
        join(
          this.userDataDirectory,
          "browsers",
          desktopFingerprintBrowserVersion,
        ),
      );
      const part = relative(managedRoot, canonical(runtime.executablePath!));
      const externalKernel =
        isAbsolute(part) || part.split(/[\\/]/).includes("..");
      return {
        provider: "fingerprint",
        externalKernel,
        ...(!externalKernel
          ? { version: desktopFingerprintBrowserVersion }
          : {}),
      };
    } catch {
      return { provider: null, externalKernel: false };
    }
  }

  initializeSwitchProfile(
    profileId: string,
    provider: "system" | "fingerprint",
  ): void {
    initializeBrowserRuntime(
      browserProfileDirectory(
        join(this.userDataDirectory, "browser-profiles"),
        profileId,
      ),
      provider === "fingerprint"
        ? this.fingerprintRuntime()
        : { provider: "system" },
    );
  }

  createProfileId(platformId: string, accountId: string): string {
    const provider = this.preferences.get().browser.defaultProvider;
    const runtime: BrowserRuntimeConfiguration =
      provider === "fingerprint"
        ? this.fingerprintRuntime()
        : { provider: "system" };
    const profileId = createBrowserProfileId(platformId, accountId);
    initializeBrowserRuntime(
      browserProfileDirectory(
        join(this.userDataDirectory, "browser-profiles"),
        profileId,
      ),
      runtime,
    );
    return profileId;
  }
}
