import type { PublicationSummary } from "@nedia-matrix/publishing";
import { describe, expect, it } from "vitest";

import {
  parseRuntimePublicationRequest,
  runtimePublicationStatus,
} from "../src/main/runtime-api/mapping/runtime-publication-mapper.js";

const request = {
  requestId: "request-1",
  target: {
    platform: "douyin",
    contentForm: "video",
    externalAccountId: "external-account-1",
  },
  content: {
    title: "标题",
    body: { type: "plain_text", text: "正文" },
    video: {
      url: "https://assets.example.test/video.mp4",
      name: "video.mp4",
      type: "video/mp4",
    },
  },
};

describe("runtime publication mapping", () => {
  it("maps Kuaishou image-text requests to the adapter's content form", () => {
    expect(
      parseRuntimePublicationRequest({
        ...request,
        target: {
          ...request.target,
          platform: "kuaishou",
          contentForm: "image_text",
        },
        content: {
          title: "标题",
          body: { type: "plain_text", text: "正文" },
          images: [
            {
              url: "https://assets.example.test/image.jpg",
              name: "image.jpg",
              type: "image/jpeg",
            },
          ],
        },
      }),
    ).toMatchObject({
      platform: "kuaishou",
      contentForm: "imageText",
      assets: [{ role: "image" }],
    });
  });

  it("rejects submissionMode instead of silently granting or ignoring it", () => {
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        submissionMode: "automatic",
      }),
    ).toThrow("does not accept submissionMode");
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        target: { ...request.target, submissionMode: "automatic" },
      }),
    ).toThrow("does not accept submissionMode");
  });

  it("requires platform identity and rejects local or Web account IDs", () => {
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        target: {
          ...request.target,
          externalAccountId: undefined,
        },
      }),
    ).toThrow("target.externalAccountId");
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        target: {
          ...request.target,
          platformAccountId: "web-account-1",
        },
      }),
    ).toThrow("externalAccountId");
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        target: {
          ...request.target,
          runtimeAccountId: "account-1",
        },
      }),
    ).toThrow("externalAccountId");
  });

  it("rejects platform identity fields longer than 128 characters", () => {
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        target: { ...request.target, platform: "p".repeat(129) },
      }),
    ).toThrow("target.platform must not exceed 128 characters");
    expect(() =>
      parseRuntimePublicationRequest({
        ...request,
        target: { ...request.target, externalAccountId: "a".repeat(129) },
      }),
    ).toThrow("target.externalAccountId must not exceed 128 characters");
  });

  it("exposes cancelled as a retryable terminal result", () => {
    const summary = {
      id: "publication-1",
      requestId: "request-1",
      platformId: "douyin",
      accountId: "account-1",
      contentForm: "video",
      title: "标题",
      body: "正文",
      assets: [],
      state: "cancelled",
      transitions: [],
      rulesVersion: "test",
      retained: false,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      lastMessage: "用户关闭了窗口",
      platformContentId: null,
      platformContentUrl: null,
    } satisfies PublicationSummary;

    expect(runtimePublicationStatus(summary)).toMatchObject({
      state: "cancelled",
      result: {
        state: "cancelled",
        ok: false,
        errorCode: "publish_cancelled",
        retryable: true,
      },
    });
  });
});
