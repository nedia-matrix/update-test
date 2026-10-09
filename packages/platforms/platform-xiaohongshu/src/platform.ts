import {
  defineAutomationPage,
  defineSessionDetectionPlan,
  defineWorkflow,
} from "@nedia-matrix/automation-engine";
import {
  definePlatformModule,
  submissionModes,
} from "@nedia-matrix/platform-sdk";

import { createXiaohongshuPublishResultMonitor } from "./result-monitor.js";
import {
  xiaohongshuAccountProfileCapability,
  xiaohongshuContentCapability,
} from "./data-reader.js";

const homePage = defineAutomationPage({
  id: "home",
  states: {
    loggedOut: {
      kind: "target",
      targetId: "session.loggedOut",
      state: "visible",
    },
  },
  targets: {
    "session.loggedOut": {
      candidates: [
        { kind: "css", selector: 'button[class*="login"]' },
        { kind: "css", selector: '[class*="login-container"]' },
      ],
    },
    "session.nickname": {
      candidates: [
        { kind: "css", selector: '[class*="user-name"]' },
        { kind: "css", selector: '[class*="nickname"]' },
        { kind: "css", selector: '[class*="user-info"] [class*="name"]' },
        { kind: "css", selector: '[class*="name-box"]' },
      ],
    },
    "session.accountId": {
      candidates: [
        { kind: "css", selector: "[data-user-id]" },
        { kind: "css", selector: "[data-userid]" },
      ],
      conditions: ["attached"],
    },
  },
});

const publishPage = defineAutomationPage({
  id: "publish",
  states: {
    videoInputReady: {
      kind: "target",
      targetId: "publish.media.videoInput",
      state: "attached",
    },
    imageInputReady: {
      kind: "target",
      targetId: "publish.media.imageInput",
      state: "attached",
    },
    editorReady: {
      kind: "target",
      targetId: "publish.editor.body",
      state: "editable",
    },
    uploadSettled: {
      kind: "not",
      condition: {
        kind: "target",
        targetId: "publish.upload.progress",
        state: "visible",
      },
    },
    submitReady: {
      kind: "target",
      targetId: "publish.submit",
      state: "enabled",
    },
  },
  targets: {
    "publish.media.videoInput": {
      candidates: [
        { kind: "css", selector: 'input[type="file"][accept*="video"]' },
        { kind: "css", selector: 'input[type="file"]' },
      ],
      conditions: ["attached", "enabled"],
    },
    "publish.media.imageInput": {
      candidates: [
        { kind: "css", selector: 'input[type="file"][accept*="image"]' },
        { kind: "css", selector: 'input[type="file"]' },
      ],
      conditions: ["attached", "enabled"],
    },
    "publish.media.imagePreview": {
      candidates: [{ kind: "css", selector: ".img-preview-area .pr" }],
      expectedCount: "one-or-more",
      conditions: ["attached", "visible"],
    },
    "publish.editor.title": {
      candidates: [
        { kind: "css", selector: 'input[placeholder*="标题"]' },
        { kind: "css", selector: 'textarea[placeholder*="标题"]' },
      ],
      conditions: ["attached", "visible", "enabled", "editable"],
    },
    "publish.editor.body": {
      candidates: [
        {
          kind: "css",
          selector: '[contenteditable="true"][data-placeholder*="正文"]',
        },
        { kind: "css", selector: 'textarea[placeholder*="正文"]' },
        { kind: "css", selector: '[contenteditable="true"]' },
      ],
      conditions: ["attached", "visible", "enabled", "editable"],
    },
    "publish.upload.progress": {
      candidates: [
        {
          kind: "css",
          selector:
            '[class*="uploading"], [class*="upload-progress"], [class*="transcod"], [role="progressbar"]',
        },
      ],
      expectedCount: "one-or-more",
      conditions: ["attached", "visible"],
    },
    "publish.submit": {
      candidates: [
        {
          kind: "css",
          selector:
            'xhs-publish-btn[is-publish="true"][submit-disabled="false"][submit-loading="false"]',
        },
      ],
      conditions: ["attached", "visible", "enabled"],
    },
    "publish.submit.confirm": {
      candidates: [
        {
          kind: "aria",
          role: "button",
          name: { value: "确认发布", exact: true },
        },
        {
          kind: "aria",
          role: "button",
          name: { value: "继续发布", exact: true },
        },
        {
          kind: "aria",
          role: "button",
          name: { value: "确定", exact: true },
        },
      ],
      conditions: ["attached", "visible", "enabled"],
    },
  },
});

function prepareWorkflow(
  id: string,
  startUrl: string,
  inputState: "videoInputReady" | "imageInputReady",
  inputTarget: "publish.media.videoInput" | "publish.media.imageInput",
  previewTarget: "publish.media.imagePreview" | null,
) {
  return defineWorkflow({
    id,
    page: publishPage,
    startUrl,
    steps: [
      { kind: "wait-for-state", stateId: inputState, timeoutMs: 30_000 },
      { kind: "upload", targetId: inputTarget, inputKey: "mediaPaths" },
      ...(previewTarget
        ? [
            {
              kind: "wait-for-target-count" as const,
              targetId: previewTarget,
              inputKey: "mediaPaths",
              timeoutMs: 1_800_000,
            },
          ]
        : []),
      {
        kind: "wait-for-state",
        stateId: "editorReady",
        timeoutMs: 600_000,
      },
      {
        kind: "fill",
        targetId: "publish.editor.title",
        inputKey: "title",
      },
      {
        kind: "fill",
        targetId: "publish.editor.body",
        inputKey: "body",
      },
      {
        kind: "append-tags",
        targetId: "publish.editor.body",
        inputKey: "tags",
        bodyInputKey: "body",
        leadingKey: "Enter",
        commitKey: "Enter",
        betweenText: " ",
        typingDelayMs: 100,
        suggestionWaitMs: 1_500,
        settleWaitMs: 500,
      },
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
    ],
  });
}

const prepareVideo = prepareWorkflow(
  "publish.prepare.video",
  "https://creator.xiaohongshu.com/publish/publish?from=menu&target=video",
  "videoInputReady",
  "publish.media.videoInput",
  null,
);
const prepareImageText = prepareWorkflow(
  "publish.prepare.imageText",
  "https://creator.xiaohongshu.com/publish/publish?from=menu&target=image",
  "imageInputReady",
  "publish.media.imageInput",
  "publish.media.imagePreview",
);
const submit = defineWorkflow({
  id: "publish.submit",
  page: publishPage,
  steps: [
    {
      kind: "click-position",
      targetId: "publish.submit",
      commitBoundary: "submission",
      xRatio: 0.65,
      yRatio: 0.5,
    },
    {
      kind: "click-if-present",
      targetId: "publish.submit.confirm",
      timeoutMs: 5_000,
    },
  ],
});

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

export const xiaohongshuPlatformModule = definePlatformModule({
  id: "xiaohongshu",
  displayName: "小红书",
  rulesVersion: "1.2.0-publish-constraints",
  browser: {
    sessionCapabilities: {
      isolatedPages: true,
      parallelSync: true,
      headlessSync: true,
    },
    startUrl: "https://creator.xiaohongshu.com/new/home",
    allowedHostSuffixes: ["xiaohongshu.com"],
  },
  accounts: {
    implementationStatus: "live-tested",
    duplicateProfileReplacement: "disabled",
    loginEntries: [
      {
        id: "default",
        displayName: "登录小红书创作中心",
        url: "https://creator.xiaohongshu.com/new/home",
      },
    ],
    detection: sessionDetection,
  },
  accountProfile: xiaohongshuAccountProfileCapability,
  content: xiaohongshuContentCapability,
  publishing: {
    implementationStatus: "live-tested",
    forms: {
      video: {
        constraints: {
          titleMaxLength: 20,
          bodyMaxLength: 1_000,
          mediaMaxCount: 1,
        },
        tagPolicy: { placement: "new-lines" },
        submissionModes,
        automation: { prepare: prepareVideo, submit },
      },
      imageText: {
        constraints: {
          titleMaxLength: 20,
          bodyMaxLength: 1_000,
          mediaMaxCount: 18,
        },
        tagPolicy: { placement: "new-lines" },
        submissionModes,
        automation: { prepare: prepareImageText, submit },
      },
    },
    createResultMonitor: createXiaohongshuPublishResultMonitor,
  },
});
