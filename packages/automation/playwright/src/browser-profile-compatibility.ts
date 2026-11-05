import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { lstat, readFile, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const playwrightRuntimeVersion: string = createRequire(import.meta.url)(
  "playwright-core/package.json",
).version;
export const browserProfileCompatibilityFile =
  "nedia-browser-compatibility.json";
export interface BrowserProfileCompatibility {
  schemaVersion: 1;
  provider: "system" | "fingerprint";
  channel: string;
  minimumBrowserVersion: string;
  playwrightVersion: string;
}
export interface BrowserProfileRequirements {
  saved?: BrowserProfileCompatibility;
  minimumBrowserVersion?: string;
}
export class BrowserProfileCompatibilityError extends Error {
  readonly code = "BROWSER_PROFILE_INCOMPATIBLE";
  constructor(readonly reason: string) {
    super(
      `账号浏览器环境不兼容（${reason}）。请使用兼容的桌面版本与浏览器，或显式创建新的账号环境；现有 Profile 未启动。`,
    );
    this.name = "BrowserProfileCompatibilityError";
  }
}
function version(value: unknown): number[] {
  if (typeof value !== "string" || !/^\d{1,6}(?:\.\d{1,6}){3}$/.test(value))
    throw new BrowserProfileCompatibilityError("无法识别浏览器版本");
  return value.split(".").map(Number);
}
export function compareBrowserVersions(a: string, b: string): number {
  const left = version(a),
    right = version(b);
  for (let i = 0; i < 4; i++) {
    const delta = left[i]! - right[i]!;
    if (delta) return Math.sign(delta);
  }
  return 0;
}
async function optionalFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
      throw new BrowserProfileCompatibilityError("版本记录格式不受支持");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Read-only: legacy profiles keep their Chromium version breadcrumb too. */
export async function readBrowserProfileRequirements(
  directory: string,
): Promise<BrowserProfileRequirements> {
  try {
    const text = await optionalFile(
      join(directory, browserProfileCompatibilityFile),
    );
    let saved: BrowserProfileCompatibility | undefined;
    if (text !== undefined) {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid compatibility record");
      const raw = value as Record<string, unknown>;
      if (
        raw.schemaVersion !== 1 ||
        (raw.provider === "fingerprint") !==
          (raw.channel === "Fingerprint Chromium") ||
        (raw.provider !== "system" && raw.provider !== "fingerprint") ||
        typeof raw.channel !== "string" ||
        ![
          "Google Chrome",
          "Microsoft Edge",
          "Playwright Chromium",
          "Fingerprint Chromium",
        ].includes(raw.channel) ||
        typeof raw.playwrightVersion !== "string" ||
        raw.playwrightVersion !== playwrightRuntimeVersion ||
        Object.keys(raw).some(
          (key) =>
            ![
              "schemaVersion",
              "provider",
              "channel",
              "minimumBrowserVersion",
              "playwrightVersion",
            ].includes(key),
        )
      )
        throw new BrowserProfileCompatibilityError(
          "Profile 格式、渠道或 Playwright 版本不受支持",
        );
      version(raw.minimumBrowserVersion);
      saved = raw as unknown as BrowserProfileCompatibility;
    }
    const legacy = (
      await optionalFile(join(directory, "Last Version"))
    )?.trim();
    if (legacy !== undefined) version(legacy);
    let minimum = saved?.minimumBrowserVersion;
    if (legacy && (!minimum || compareBrowserVersions(legacy, minimum) > 0))
      minimum = legacy;
    return { saved, minimumBrowserVersion: minimum };
  } catch (error) {
    if (error instanceof BrowserProfileCompatibilityError) throw error;
    throw new BrowserProfileCompatibilityError("无法读取 Profile 版本记录");
  }
}
export function assertBrowserProfileCompatible(
  requirements: BrowserProfileRequirements,
  selected: {
    provider: "system" | "fingerprint";
    channel: string;
    browserVersion: string;
  },
  explicitFingerprintSwitch = false,
): void {
  version(selected.browserVersion);
  const saved = requirements.saved;
  if (
    saved &&
    (saved.provider !== selected.provider ||
      saved.channel !== selected.channel) &&
    !(
      explicitFingerprintSwitch &&
      saved.provider === "system" &&
      selected.provider === "fingerprint"
    )
  )
    throw new BrowserProfileCompatibilityError("浏览器渠道已绑定");
  if (
    requirements.minimumBrowserVersion &&
    compareBrowserVersions(
      selected.browserVersion,
      requirements.minimumBrowserVersion,
    ) < 0
  )
    throw new BrowserProfileCompatibilityError(
      `拒绝浏览器降级 ${requirements.minimumBrowserVersion} → ${selected.browserVersion}`,
    );
}
/** Reserve the version before opening a profile, even if its launch later fails. */
export async function reserveBrowserProfileVersion(
  directory: string,
  selected: {
    provider: "system" | "fingerprint";
    channel: string;
    browserVersion: string;
  },
  explicitFingerprintSwitch = false,
): Promise<void> {
  const requirements = await readBrowserProfileRequirements(directory);
  assertBrowserProfileCompatible(
    requirements,
    selected,
    explicitFingerprintSwitch,
  );
  const next: BrowserProfileCompatibility = {
    schemaVersion: 1,
    provider: selected.provider,
    channel: selected.channel,
    minimumBrowserVersion: selected.browserVersion,
    playwrightVersion: playwrightRuntimeVersion,
  };
  if (
    requirements.saved &&
    Object.entries(next).every(
      ([key, value]) =>
        (requirements.saved as unknown as Record<string, unknown>)[key] ===
        value,
    )
  )
    return;
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.browser-compatibility-${randomUUID()}.tmp`,
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, browserProfileCompatibilityFile));
    if (process.platform !== "win32") {
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
