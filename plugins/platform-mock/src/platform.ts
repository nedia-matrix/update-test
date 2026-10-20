import {
  defineAutomationPage,
  defineSessionDetectionPlan,
  defineWorkflow,
} from "@nedia-matrix/automation-engine";
import {
  definePlatformModule,
  submissionModes,
} from "@nedia-matrix/platform-sdk";

import { createMockPublishResultMonitor } from "./result-monitor.js";

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
      candidates: [{ kind: "css", selector: ".login-container" }],
    },
    "session.nickname": {
      candidates: [{ kind: "css", selector: ".user-name" }],
    },
    "session.accountId": {
      candidates: [{ kind: "css", selector: "[data-user-id]" }],
      conditions: ["attached"],
    },
  },
});

const publishPage = defineAutomationPage({
  id: "publish",
  states: {
    mediaUploaded: {
      kind: "target",
      targetId: "publish.media.preview",
      state: "visible",
    },
    editorReady: {
      kind: "target",
      targetId: "publish.editor.body",
      state: "editable",
    },
  },
  targets: {
    "publish.media.input": {
      candidates: [{ kind: "test-id", value: "publish-media" }],
      conditions: ["attached", "enabled"],
    },
    "publish.media.preview": {
      candidates: [{ kind: "test-id", value: "publish-media-preview" }],
      expectedCount: "one-or-more",
    },
    "publish.editor.title": {
      candidates: [{ kind: "test-id", value: "publish-title" }],
      conditions: ["attached", "visible", "enabled", "editable"],
    },
    "publish.editor.body": {
      candidates: [{ kind: "test-id", value: "publish-body" }],
      conditions: ["attached", "visible", "enabled", "editable"],
    },
    "publish.submit": {
      candidates: [{ kind: "test-id", value: "publish-submit" }],
      conditions: ["attached", "visible", "enabled"],
    },
  },
});

function prepareWorkflow(id: string, startUrl: string) {
  return defineWorkflow({
    id,
    page: publishPage,
    startUrl,
    steps: [
      {
        kind: "upload",
        targetId: "publish.media.input",
        inputKey: "mediaPaths",
      },
      { kind: "wait-for-state", stateId: "mediaUploaded", timeoutMs: 5_000 },
      { kind: "wait-for-state", stateId: "editorReady", timeoutMs: 5_000 },
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
        leadingKey: "Space",
        commitKey: "Space",
        betweenText: " ",
        typingDelayMs: 20,
        settleWaitMs: 30,
      },
    ],
  });
}

const prepareVideo = prepareWorkflow(
  "publish.prepare.video",
  "http://127.0.0.1:4173/publish?contentForm=video",
);
const prepareImageText = prepareWorkflow(
  "publish.prepare.imageText",
  "http://127.0.0.1:4173/publish?contentForm=imageText",
);
const submit = defineWorkflow({
  id: "publish.submit",
  page: publishPage,
  steps: [
    {
      kind: "click",
      targetId: "publish.submit",
      commitBoundary: "submission",
    },
  ],
});

const sessionDetection = defineSessionDetectionPlan({
  probes: [
    {
      identityScheme: "mock.account_id",
      source: {
        kind: "request",
        url: "http://127.0.0.1:4173/api/session",
      },
      fields: {
        externalAccountId: ["data", "accountId"],
        nickname: ["data", "nickname"],
        avatarUrl: ["data", "avatarUrl"],
      },
    },
  ],
  domFallback: {
    identityScheme: "mock.account_id",
    page: homePage,
    loggedOutTargetId: "session.loggedOut",
    nicknameTargetId: "session.nickname",
    accountIdTargetId: "session.accountId",
    accountIdAttributes: ["data-user-id"],
  },
});

export const mockPlatformModule = definePlatformModule({
  settings: {
    submissionMode: {
      type: "select",
      label: "发布提交方式",
      options: [
        { value: "automatic", label: "自动提交" },
        { value: "manual_confirmation", label: "人工确认" },
      ],
      default: "manual_confirmation",
    },
  },
  id: "mock",
  displayName: "本地模拟平台",
  rulesVersion: "3.0.0-capabilities",
  browser: {
    sessionCapabilities: {
      isolatedPages: true,
      parallelSync: true,
      headlessSync: true,
    },
    startUrl: "http://127.0.0.1:4173/home",
    allowedHostSuffixes: ["127.0.0.1"],
  },
  accounts: {
    implementationStatus: "fixture-tested",
    duplicateProfileReplacement: "enabled",
    loginEntries: [
      {
        id: "default",
        displayName: "登录本地模拟平台",
        url: "http://127.0.0.1:4173/home",
      },
    ],
    detection: sessionDetection,
  },
  publishing: {
    implementationStatus: "fixture-tested",
    forms: {
      video: {
        constraints: {
          titleMaxLength: 100,
          bodyMaxLength: 2_000,
          mediaMaxCount: 1,
        },
        tagPolicy: { placement: "inline", maxCount: 5 },
        submissionModes,
        automation: { prepare: prepareVideo, submit },
      },
      imageText: {
        constraints: {
          titleMaxLength: 100,
          bodyMaxLength: 2_000,
          mediaMaxCount: 9,
        },
        tagPolicy: { placement: "inline", maxCount: 5 },
        submissionModes,
        automation: { prepare: prepareImageText, submit },
      },
    },
    createResultMonitor: createMockPublishResultMonitor,
  },
});
