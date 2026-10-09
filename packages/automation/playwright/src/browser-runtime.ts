import { randomInt, randomUUID, createHash } from "node:crypto";
import {
  access,
  cp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { chromium } from "playwright";

export interface BrowserRuntimeConfiguration {
  provider: "system" | "fingerprint";
  executablePath?: string;
  locale?: string;
  timezoneId?: string;
}
export interface StoredBrowserRuntime {
  version: 1;
  provider: "system" | "fingerprint";
  executablePath?: string;
  fingerprintSeed: number;
  locale: string;
  timezoneId: string;
  channel?: string;
  width: number;
  height: number;
}
const metadataName = "nedia-browser-runtime.json";

export function browserRuntimeFromEnvironment(
  env = process.env,
): BrowserRuntimeConfiguration | undefined {
  const path = env.NEDIA_FINGERPRINT_BROWSER_PATH;
  if (!path) return undefined;
  if (!isAbsolute(path))
    throw new TypeError("NEDIA_FINGERPRINT_BROWSER_PATH must be absolute");
  return { provider: "fingerprint", executablePath: path };
}

function validateRuntime(value: unknown): StoredBrowserRuntime {
  if (!value || typeof value !== "object")
    throw new Error("Invalid browser runtime metadata");
  const r = value as StoredBrowserRuntime;
  if (
    r.version !== 1 ||
    !["system", "fingerprint"].includes(r.provider) ||
    !Number.isInteger(r.fingerprintSeed) ||
    r.fingerprintSeed < 1 ||
    r.fingerprintSeed > 2147483647 ||
    typeof r.locale !== "string" ||
    typeof r.timezoneId !== "string" ||
    !Number.isInteger(r.width) ||
    !Number.isInteger(r.height) ||
    r.width < 640 ||
    r.height < 480 ||
    r.width > 7680 ||
    r.height > 4320 ||
    (r.channel !== undefined && typeof r.channel !== "string") ||
    (r.provider === "fingerprint" &&
      (typeof r.executablePath !== "string" || !isAbsolute(r.executablePath)))
  )
    throw new Error(
      "Invalid browser runtime metadata; refusing to regenerate account identity",
    );
  new Intl.DateTimeFormat(r.locale, { timeZone: r.timezoneId });
  return r;
}

export async function saveBrowserRuntime(
  directory: string,
  runtime: StoredBrowserRuntime,
): Promise<void> {
  validateRuntime(runtime);
  const temporary = join(directory, `.${metadataName}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(runtime, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(directory, metadataName));
  } finally {
    await rm(temporary, { force: true });
  }
}

const metadataWrites = new Map<string, Promise<unknown>>();
export async function loadBrowserRuntime(
  directory: string,
  requested?: BrowserRuntimeConfiguration,
): Promise<StoredBrowserRuntime> {
  const previous = metadataWrites.get(directory) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => readBrowserRuntime(directory, requested));
  metadataWrites.set(directory, result);
  try {
    return await result;
  } finally {
    if (metadataWrites.get(directory) === result)
      metadataWrites.delete(directory);
  }
}

/** Runtime and seed live with the profile and survive application restarts. */
async function readBrowserRuntime(
  directory: string,
  requested?: BrowserRuntimeConfiguration,
): Promise<StoredBrowserRuntime> {
  requested ??= browserRuntimeFromEnvironment();
  let stored: StoredBrowserRuntime | undefined;
  try {
    stored = validateRuntime(
      JSON.parse(await readFile(join(directory, metadataName), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stored && !requested) return stored;
  if (stored && requested?.provider === stored.provider) {
    if (
      requested.executablePath &&
      requested.executablePath !== stored.executablePath
    )
      throw new Error(
        "Browser executable is pinned to this profile; replace the binary at its existing path or use a new account profile",
      );
    if (
      (requested.locale && requested.locale !== stored.locale) ||
      (requested.timezoneId && requested.timezoneId !== stored.timezoneId)
    )
      throw new Error("Browser environment is pinned to this account profile");
    return stored;
  }
  if (stored && requested?.provider === "system")
    throw new Error(
      "Fingerprint profiles cannot silently fall back to a system browser; restore the saved profile backup or use a new profile",
    );
  const runtime = validateRuntime({
    version: 1,
    provider: requested?.provider ?? "system",
    ...(requested?.executablePath
      ? { executablePath: requested.executablePath }
      : {}),
    fingerprintSeed: stored?.fingerprintSeed ?? randomInt(1, 2147483648),
    locale: requested?.locale ?? stored?.locale ?? "zh-CN",
    timezoneId:
      requested?.timezoneId ??
      stored?.timezoneId ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    width: stored?.width ?? 1366,
    height: stored?.height ?? 768,
  });
  if (runtime.provider === "fingerprint") {
    await verifyFingerprintBrowser(runtime.executablePath!);
    // Browser vendors/versions must not mutate the only copy of an existing profile.
    const entries = await readdir(directory);
    if (
      entries.some(
        (name) =>
          name !== metadataName && !name.startsWith(".nedia-browser-runtime"),
      )
    ) {
      const backup = `${directory}.before-fingerprint-${randomUUID()}`;
      await cp(directory, backup, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (source) =>
          !["SingletonLock", "SingletonCookie", "SingletonSocket"].includes(
            source.split(/[\\/]/).at(-1)!,
          ),
      });
    }
  }
  await saveBrowserRuntime(directory, runtime);
  return runtime;
}

export function fingerprintArguments(seed: number): string[] {
  return [
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${process.platform === "darwin" ? "macos" : "windows"}`,
    "--fingerprint-brand=Chrome",
  ];
}

const verified = new Map<string, Promise<void>>();
/** Two native probes reject stock Chrome even when it silently ignores fingerprint flags. */
export async function verifyFingerprintBrowser(
  executablePath: string,
): Promise<void> {
  if (!isAbsolute(executablePath))
    throw new TypeError("Fingerprint browser path must be absolute");
  await access(executablePath, constants.X_OK);
  const digest = createHash("sha256")
    .update(await readFile(executablePath))
    .digest("hex");
  const key = `${executablePath}:${digest}`;
  let probe = verified.get(key);
  if (!probe) {
    probe = (async () => {
      for (const concurrency of [3, 7]) {
        const directory = await mkdtemp(
          join(tmpdir(), "nedia-fingerprint-probe-"),
        );
        try {
          const context = await chromium.launchPersistentContext(directory, {
            executablePath,
            headless: true,
            chromiumSandbox: true,
            timeout: 30_000,
            args: [
              ...fingerprintArguments(12345),
              `--fingerprint-hardware-concurrency=${concurrency}`,
            ],
          });
          try {
            const page = context.pages()[0] ?? (await context.newPage());
            const actual = await page.evaluate(
              () => navigator.hardwareConcurrency,
            );
            if (actual !== concurrency)
              throw new Error(
                "Browser does not implement the required native fingerprint flags",
              );
          } finally {
            await context.close();
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    })();
    verified.set(key, probe);
    void probe.catch(() => verified.delete(key));
  }
  return probe;
}
