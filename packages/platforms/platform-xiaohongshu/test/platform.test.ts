import { describe, expect, it, vi } from "vitest";
import {
  detectPlatformSession,
  type AutomationDriver,
} from "@nedia-matrix/automation-engine";

import { xiaohongshuPlatformModule } from "../src/index.js";

describe("Xiaohongshu platform workflow", () => {
  it("uses personal_info as the only account identity source", () => {
    expect(xiaohongshuPlatformModule.accounts.detection.probes).toEqual([
      expect.objectContaining({
        identityScheme: "xiaohongshu.red_num",
        source: {
          kind: "observed-response",
          method: "GET",
          url: "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info",
          timeoutMs: 10_000,
        },
      }),
    ]);
    expect(
      xiaohongshuPlatformModule.accounts.detection.domFallback,
    ).toBeUndefined();
  });

  it("recognizes the page session even when a direct API request would be forbidden", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ status: 403, ok: false, body: null });
    const waitForJsonResponse = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: {
        data: {
          red_num: "123456",
          name: "测试账号",
          avatar: "https://example.test/avatar.png",
        },
      },
    });
    await expect(
      detectPlatformSession(
        xiaohongshuPlatformModule.accounts.detection,
        {} as AutomationDriver,
        { fetchJson, waitForJsonResponse },
      ),
    ).resolves.toMatchObject({
      status: "authenticated",
      identityScheme: "xiaohongshu.red_num",
      externalAccountId: "123456",
      nickname: "测试账号",
      source: "response",
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, ok: false, body: null, expected: "login_required" },
    { status: 403, ok: false, body: null, expected: "login_required" },
    { status: 200, ok: true, body: {}, expected: "unknown" },
  ])(
    "does not authenticate an invalid page response ($status)",
    async ({ expected, ...response }) => {
      await expect(
        detectPlatformSession(
          xiaohongshuPlatformModule.accounts.detection,
          {
            currentUrl: async () => "https://creator.xiaohongshu.com/new/home",
          } as AutomationDriver,
          {
            fetchJson: vi.fn(),
            waitForJsonResponse: vi.fn().mockResolvedValue(response),
          },
        ),
      ).resolves.toMatchObject({ status: expected });
    },
  );

  it.each([
    [
      "https://creator.xiaohongshu.com/login?redirect=%2Fnew%2Fhome",
      "login_required",
    ],
    ["https://creator.xiaohongshu.com/new/home", "unknown"],
    ["https://other.example/login", "unknown"],
  ])(
    "classifies a missing identity response on %s as %s",
    async (url, status) => {
      await expect(
        detectPlatformSession(
          xiaohongshuPlatformModule.accounts.detection,
          { currentUrl: async () => url } as AutomationDriver,
          {
            fetchJson: vi.fn(),
            waitForJsonResponse: vi.fn().mockResolvedValue(null),
          },
        ),
      ).resolves.toMatchObject({ status });
    },
  );

  it("submits through the closed-shadow publish component host", () => {
    const submit =
      xiaohongshuPlatformModule.publishing?.forms.imageText?.automation.submit;

    expect(submit?.page.targets["publish.submit"]?.candidates[0]).toEqual({
      kind: "css",
      selector:
        'xhs-publish-btn[is-publish="true"][submit-disabled="false"][submit-loading="false"]',
    });
    expect(submit?.steps).toEqual([
      expect.objectContaining({
        kind: "click-position",
        targetId: "publish.submit",
        xRatio: 0.65,
        yRatio: 0.5,
      }),
      {
        kind: "click-if-present",
        targetId: "publish.submit.confirm",
        timeoutMs: 5_000,
      },
    ]);
  });

  it("waits for uploads and the submit component before crossing the submit boundary", () => {
    const prepare =
      xiaohongshuPlatformModule.publishing?.forms.imageText?.automation.prepare;

    expect(prepare?.steps).toContainEqual({
      kind: "wait-for-target-count",
      targetId: "publish.media.imagePreview",
      inputKey: "mediaPaths",
      timeoutMs: 1_800_000,
    });
    expect(prepare?.steps.slice(-2)).toEqual([
      {
        kind: "wait-for-state",
        stateId: "uploadSettled",
        timeoutMs: 1_800_000,
      },
      {
        kind: "wait-for-state",
        stateId: "submitReady",
        timeoutMs: 60_000,
      },
    ]);
  });
});
