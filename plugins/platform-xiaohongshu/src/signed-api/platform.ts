import { xiaohongshuAccounts } from "../shared/accounts.js";
import { definePlatformModule } from "@nedia-matrix/platform-sdk";

import {
  xhsAccountProfileCapability,
  xhsContentCapability,
} from "./data-reader.js";

export const xhsSignPlatformModule = definePlatformModule({
  settings: {
    submissionMode: {
      type: "select",
      label: "发布提交方式",
      options: [
        {
          value: "automatic",
          label: "自动提交",
          description: "当前仅支持自动提交发布。",
        },
      ],
      default: "automatic",
    },
  },
  id: "xiaohongshu",
  displayName: "小红书",
  rulesVersion: "0.2.0-experimental-signed-api",
  browser: {
    startUrl: "https://creator.xiaohongshu.com/new/home",
    allowedHostSuffixes: ["xiaohongshu.com"],
    sessionCapabilities: {
      isolatedPages: true,
      parallelSync: false,
      headlessSync: true,
      headlessPublish: true,
    },
  },
  accounts: xiaohongshuAccounts,
  accountProfile: xhsAccountProfileCapability,
  content: xhsContentCapability,
  publishing: {
    executionMode: "publisher",
    implementationStatus: "fixture-tested",
    forms: {
      video: {
        executionMode: "publisher",
        adapterId: "xhs-sign.video.v1",
        submissionModes: ["automatic"],
        constraints: {
          titleMaxLength: 20,
          bodyMaxLength: 1000,
          mediaMaxCount: 1,
        },
      },
      imageText: {
        executionMode: "publisher",
        adapterId: "xhs-sign.imageText.v1",
        submissionModes: ["automatic"],
        constraints: {
          titleMaxLength: 20,
          bodyMaxLength: 1000,
          mediaMaxCount: 18,
        },
      },
    },
  },
});
