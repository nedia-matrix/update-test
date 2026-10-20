import { defineSessionDetectionPlan } from "@nedia-matrix/automation-engine";
import type { PlatformModule } from "@nedia-matrix/platform-sdk";

const sessionDetection = defineSessionDetectionPlan({
  loggedOutUrl: "https://creator.xiaohongshu.com/login",
  probes: [
    {
      identityScheme: "xiaohongshu.red_num",
      source: {
        kind: "observed-response",
        method: "GET",
        url: "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info",
        timeoutMs: 10_000,
      },
      fields: {
        externalAccountId: ["data", "red_num"],
        nickname: ["data", "name"],
        avatarUrl: ["data", "avatar"],
      },
    },
  ],
});

export const xiaohongshuAccounts: PlatformModule["accounts"] = {
  implementationStatus: "live-tested",
  duplicateProfileReplacement: "enabled",
  loginEntries: [
    {
      id: "default",
      displayName: "登录小红书创作中心",
      url: "https://creator.xiaohongshu.com/new/home",
    },
  ],
  detection: sessionDetection,
};
