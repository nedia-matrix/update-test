import { describe, expect, it } from "vitest";

import { desktopPlatformSummaries } from "../src/main/platforms/platform-registry.js";
import { runtimeSupportedTargets } from "../src/main/runtime-api/mapping/runtime-supported-targets.js";

describe("runtime supported publication targets", () => {
  it("advertises image and video publication for every built-in platform", () => {
    const targets = runtimeSupportedTargets(desktopPlatformSummaries());
    expect(targets).toHaveLength(6);
    for (const platform of ["douyin", "xiaohongshu", "kuaishou"]) {
      expect(targets).toEqual(
        expect.arrayContaining([
          { platform, contentForm: "image_text" },
          { platform, contentForm: "video" },
        ]),
      );
    }
  });

  it("excludes forms that cannot use the runtime's human confirmation mode", () => {
    const platform = desktopPlatformSummaries().find(
      (item) => item.id === "kuaishou",
    )!;
    expect(
      runtimeSupportedTargets([
        { ...platform, publishCapabilities: [] },
        {
          ...platform,
          publishCapabilities: platform.publishCapabilities.map((form) => ({
            ...form,
            submissionModes: ["automatic"],
          })),
        },
      ]),
    ).toEqual([]);
  });
});
