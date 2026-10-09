import { describe, expect, it, vi } from "vitest";

import {
  checkForApplicationUpdate,
  findLatestRelease,
  isNewerVersion,
  releasePageUrl,
  type ApplicationRelease,
} from "../src/main/updates/application-update.js";

const latestRelease: ApplicationRelease = {
  version: "0.3.0",
};

describe("application update", () => {
  it("compares stable versions numerically", () => {
    expect(isNewerVersion("0.3.0", "0.2.4")).toBe(true);
    expect(isNewerVersion("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.2.4", "0.2.4")).toBe(false);
    expect(isNewerVersion("0.2.3", "0.2.4")).toBe(false);
    expect(isNewerVersion("0.3.0-beta.1", "0.2.4")).toBe(false);
    expect(isNewerVersion("0.03.0", "0.2.4")).toBe(false);
    expect(isNewerVersion("9007199254740992.0.0", "0.2.4")).toBe(false);
  });

  it("builds download pages only for stable versions", () => {
    expect(releasePageUrl("0.3.0")).toBe(
      "https://github.com/nedia-matrix/desktop/releases/tag/v0.3.0",
    );
    expect(releasePageUrl("v0.10.2")).toBe(
      "https://github.com/nedia-matrix/desktop/releases/tag/v0.10.2",
    );
    expect(releasePageUrl("0.3.0-beta.1")).toBeNull();
  });

  it("reads the latest stable tag from the GitHub Releases API", async () => {
    const fetcher = vi.fn(async () => {
      return Response.json({ tag_name: "v0.3.0" });
    });

    await expect(
      findLatestRelease(fetcher as typeof globalThis.fetch),
    ).resolves.toEqual(latestRelease);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/nedia-matrix/desktop/releases/latest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
  });

  it("reports an invalid latest-release response as a check failure", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "ok" }));

    await expect(
      findLatestRelease(fetcher as typeof globalThis.fetch),
    ).rejects.toThrow(
      "Latest release response does not contain a stable version tag",
    );
  });

  it.each(["prerelease", "draft"])(
    "does not accept a %s release even with a stable-looking tag",
    async (field) => {
      await expect(
        findLatestRelease(async () =>
          Response.json({ tag_name: "v0.4.0", [field]: true }),
        ),
      ).rejects.toThrow("published stable release");
    },
  );

  it("retains GitHub attachment names/URLs and ignores malformed entries", async () => {
    const asset = {
      name: "update-manifest.json",
      browser_download_url: "https://github.com/manifest",
    };
    await expect(
      findLatestRelease(
        async () =>
          Response.json({
            tag_name: "v0.4.0",
            assets: [asset, null, { name: 1 }],
          }),
        "github",
      ),
    ).resolves.toEqual({
      version: "0.4.0",
      assets: [{ name: asset.name, url: asset.browser_download_url }],
    });
  });

  it("returns the available version without opening its release page", async () => {
    await expect(
      checkForApplicationUpdate({
        currentVersion: "0.2.4",
        findLatestRelease: async () => latestRelease,
      }),
    ).resolves.toEqual({
      status: "update-available",
      currentVersion: "0.2.4",
      latestVersion: "0.3.0",
    });
  });

  it("reports that the current version is up to date", async () => {
    await expect(
      checkForApplicationUpdate({
        currentVersion: latestRelease.version,
        findLatestRelease: async () => latestRelease,
      }),
    ).resolves.toEqual({
      status: "up-to-date",
      currentVersion: "0.3.0",
    });
  });
});
