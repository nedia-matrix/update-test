import type { ApplicationUpdateCheckResult } from "../../bridge/contracts.js";
import { publicUpdateFetch } from "./public-update-fetch.js";
import { fetchUpdateAsset, readBoundedResponse } from "./update-network.js";
import type { UpdateManifest } from "./update-manifest.js";
const updateRepository = "nedia-matrix/desktop";

export type ApplicationUpdateSource = "github" | "manifest";

const UPDATE_SOURCES = {
  github: {
    latestReleaseApiUrl: `https://api.github.com/repos/${updateRepository}/releases/latest`,
    releasePageUrl: (tag: string) =>
      `https://github.com/${updateRepository}/releases/tag/${tag}`,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "NediaMatrix-update-check",
    },
  },
} as const;

const VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UPDATE_CHECK_TIMEOUT_MS = 8_000;

export function configuredUpdateSource(): ApplicationUpdateSource {
  return "github";
}

export interface ApplicationRelease {
  version: string;
  assets?: Array<{ name: string; url: string }>;
  manifest?: UpdateManifest;
}

export interface ApplicationUpdateDependencies {
  currentVersion: string;
  findLatestRelease(): Promise<ApplicationRelease>;
}

type NumericVersion = readonly [major: number, minor: number, patch: number];

function parseVersion(version: string): NumericVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts: NumericVersion = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewerVersion(
  candidateVersion: string,
  currentVersion: string,
): boolean {
  const candidate = parseVersion(candidateVersion);
  const current = parseVersion(currentVersion);
  if (!candidate || !current) return false;

  const [candidateMajor, candidateMinor, candidatePatch] = candidate;
  const [currentMajor, currentMinor, currentPatch] = current;
  if (candidateMajor !== currentMajor) return candidateMajor > currentMajor;
  if (candidateMinor !== currentMinor) return candidateMinor > currentMinor;
  return candidatePatch > currentPatch;
}

function releaseFromTag(tag: unknown): ApplicationRelease | null {
  if (typeof tag !== "string" || !parseVersion(tag)) return null;
  return {
    version: tag.replace(/^v/, ""),
  };
}

export function releasePageUrl(
  version: string,
  source: ApplicationUpdateSource = configuredUpdateSource(),
  repository: string = updateRepository,
): string | null {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return null;

  if (source !== "github") return null;
  return `https://github.com/${repository}/releases/tag/v${parsedVersion.join(".")}`;
}

export async function findLatestRelease(
  fetcher: typeof globalThis.fetch = publicUpdateFetch,
  source: ApplicationUpdateSource = configuredUpdateSource(),
  repository: string = updateRepository,
): Promise<ApplicationRelease> {
  if (source !== "github") throw new Error("协议更新源需读取受信清单");
  const configuration = UPDATE_SOURCES.github;
  const response = await fetchUpdateAsset(
    `https://api.github.com/repos/${repository}/releases/latest`,
    "github",
    AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    fetcher,
    { ...configuration.headers },
  );
  if (!response.ok) {
    throw new Error(`Latest release request returned HTTP ${response.status}`);
  }

  const payload: unknown = JSON.parse(
    Buffer.from(await readBoundedResponse(response, 512 * 1024)).toString(
      "utf8",
    ),
  );
  if (
    typeof payload === "object" &&
    payload !== null &&
    (("prerelease" in payload && payload.prerelease === true) ||
      ("draft" in payload && payload.draft === true))
  ) {
    throw new Error("Latest release is not a published stable release");
  }
  const tag =
    typeof payload === "object" && payload !== null && "tag_name" in payload
      ? payload.tag_name
      : undefined;
  const release = releaseFromTag(tag);
  if (!release) {
    throw new Error(
      "Latest release response does not contain a stable version tag",
    );
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "assets" in payload &&
    Array.isArray(payload.assets)
  ) {
    release.assets = payload.assets.flatMap((asset: unknown) => {
      if (
        typeof asset !== "object" ||
        asset === null ||
        !("name" in asset) ||
        !("browser_download_url" in asset)
      )
        return [];
      return typeof asset.name === "string" &&
        typeof asset.browser_download_url === "string"
        ? [{ name: asset.name, url: asset.browser_download_url }]
        : [];
    });
  }
  return release;
}

export async function checkForApplicationUpdate(
  dependencies: ApplicationUpdateDependencies,
): Promise<ApplicationUpdateCheckResult> {
  const latestRelease = await dependencies.findLatestRelease();
  if (!isNewerVersion(latestRelease.version, dependencies.currentVersion)) {
    return {
      status: "up-to-date",
      currentVersion: dependencies.currentVersion,
    };
  }

  return {
    status: "update-available",
    currentVersion: dependencies.currentVersion,
    latestVersion: latestRelease.version,
  };
}
