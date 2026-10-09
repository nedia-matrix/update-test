import { describe, expect, it } from "vitest";

import {
  normalizePublishBody,
  preparePublishText,
  type PlatformPublishFormCapability,
} from "../src/index.js";

function form(
  placement: "inline" | "new-lines",
  maxCount?: number,
): PlatformPublishFormCapability {
  return {
    constraints: {},
    tagPolicy: {
      placement,
      ...(maxCount === undefined ? {} : { maxCount }),
    },
    submissionModes: ["automatic", "manual_confirmation"],
    automation: {} as PlatformPublishFormCapability["automation"],
  };
}

describe("preparePublishText", () => {
  it("separates an inline topic from preceding body text", () => {
    const inline = form("inline");
    const body = "这样吗#与异性的分寸感 #朋友的重要性";
    const normalized = normalizePublishBody(inline, body);
    expect(normalized).toBe("这样吗 #与异性的分寸感 #朋友的重要性");
    expect(normalizePublishBody(inline, normalized)).toBe(normalized);
    expect(preparePublishText(inline, normalized, ["与异性的分寸感"])).toEqual({
      body: normalized,
      tags: ["与异性的分寸感"],
      tagsToAppend: [],
    });
  });

  it("preserves URL fragments and other platforms' body formatting", () => {
    const body = "详见 https://example.test/page#section 正文#旅行";
    expect(normalizePublishBody(form("inline"), body)).toBe(
      "详见 https://example.test/page#section 正文 #旅行",
    );
    expect(normalizePublishBody(form("new-lines"), body)).toBe(body);
  });

  it("normalizes and appends Douyin-style inline tags", () => {
    expect(
      preparePublishText(form("inline", 5), "正文", [
        " #旅行 ",
        "旅行",
        "周末去哪儿",
      ]),
    ).toEqual({
      body: "正文 #旅行 #周末去哪儿",
      tags: ["旅行", "周末去哪儿"],
      tagsToAppend: ["旅行", "周末去哪儿"],
    });
  });

  it("appends Xiaohongshu-style tags on separate lines without duplicates", () => {
    expect(
      preparePublishText(form("new-lines"), "正文里已有 #旅行", [
        "旅行",
        "周末去哪儿",
      ]),
    ).toEqual({
      body: "正文里已有 #旅行\n#周末去哪儿",
      tags: ["旅行", "周末去哪儿"],
      tagsToAppend: ["周末去哪儿"],
    });
  });

  it("does not confuse a longer hashtag with an exact existing tag", () => {
    expect(
      preparePublishText(form("inline"), "正文 #旅行攻略", ["旅行"]),
    ).toEqual({
      body: "正文 #旅行攻略 #旅行",
      tags: ["旅行"],
      tagsToAppend: ["旅行"],
    });
  });

  it("rejects a platform-specific tag count overflow", () => {
    expect(() =>
      preparePublishText(form("inline", 1), "正文", ["旅行", "周末"]),
    ).toThrow("at most 1 tags");
  });
});
