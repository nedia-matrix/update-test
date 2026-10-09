import type {
  AutomationDriver,
  AutomationKey,
  ElementReference,
  LocatorCandidate,
  SessionProbeClient,
  AutomationTraceEvent,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

import {
  defineAutomationPage,
  defineSessionDetectionPlan,
  defineWorkflow,
  detectPlatformSession,
  executeWorkflow,
} from "../src/index.js";

class MemoryDriver implements AutomationDriver {
  readonly actions: string[] = [];
  private url = "about:blank";

  async currentUrl() {
    return this.url;
  }

  async navigate(url: string) {
    this.url = url;
    this.actions.push(`navigate:${url}`);
  }

  async wait() {}

  async query(candidate: LocatorCandidate) {
    const id = candidate.kind === "test-id" ? candidate.value : undefined;
    if (!id) return [];
    return [
      {
        id,
        state: {
          attached: true,
          visible: true,
          enabled: true,
          editable: id === "body",
        },
      },
    ];
  }

  async click(target: ElementReference) {
    this.actions.push(`click:${target.id}`);
  }

  async clickAtPosition(
    target: ElementReference,
    xRatio: number,
    yRatio: number,
  ) {
    this.actions.push(`position-click:${target.id}:${xRatio}:${yRatio}`);
  }

  async clickClosedShadowDescendant(
    target: ElementReference,
    descendantTag: string,
    descendantClass: string,
  ) {
    this.actions.push(
      `shadow-click:${target.id}:${descendantTag}:${descendantClass}`,
    );
  }

  async fill(target: ElementReference, value: string) {
    this.actions.push(`fill:${target.id}:${value}`);
  }

  async typeText(target: ElementReference, value: string, delayMs = 0) {
    this.actions.push(`type:${target.id}:${value}:${delayMs}`);
  }

  async pressKey(target: ElementReference, key: AutomationKey) {
    this.actions.push(`press:${target.id}:${key}`);
  }

  async uploadFiles(target: ElementReference, paths: readonly string[]) {
    this.actions.push(`upload:${target.id}:${paths.join(",")}`);
  }

  async dropFiles(target: ElementReference, paths: readonly string[]) {
    this.actions.push(`drop:${target.id}:${paths.join(",")}`);
  }

  async textContent(target: ElementReference) {
    return target.id === "nickname" ? "测试账号" : null;
  }

  async attribute(target: ElementReference, name: string) {
    return target.id === "account" && name === "data-id" ? "user-42" : null;
  }

  async captureEvidence(reason: string) {
    return { id: "evidence-1", capturedAt: new Date(0).toISOString(), reason };
  }
}

const page = defineAutomationPage({
  id: "publish",
  states: {
    editorReady: { kind: "target", targetId: "body", state: "editable" },
  },
  targets: {
    media: { candidates: [{ kind: "test-id", value: "media" }] },
    body: { candidates: [{ kind: "test-id", value: "body" }] },
    submit: { candidates: [{ kind: "test-id", value: "submit" }] },
  },
});

describe("automation definitions and execution", () => {
  it("rejects broken semantic references when definitions are created", () => {
    expect(() =>
      defineAutomationPage({
        id: "broken",
        states: {
          ready: { kind: "target", targetId: "missing", state: "visible" },
        },
        targets: {},
      }),
    ).toThrow(/Unknown target: missing/);
  });

  it("executes a workflow that owns its page and start URL", async () => {
    const workflow = defineWorkflow({
      id: "publish.prepare",
      page,
      startUrl: "https://example.test/publish",
      steps: [
        { kind: "upload", targetId: "media", inputKey: "mediaPaths" },
        { kind: "wait-for-state", stateId: "editorReady" },
        { kind: "fill", targetId: "body", inputKey: "body" },
        { kind: "click", targetId: "submit" },
      ],
    });
    const driver = new MemoryDriver();

    await executeWorkflow(workflow, driver, {
      mediaPaths: ["/tmp/cover.png"],
      body: "正文",
    });

    expect(driver.actions).toEqual([
      "navigate:https://example.test/publish",
      "upload:media:/tmp/cover.png",
      "fill:body:正文",
      "click:submit",
    ]);
  });

  it("validates required input kinds before changing the page", async () => {
    const workflow = defineWorkflow({
      id: "publish.prepare",
      page,
      startUrl: "https://example.test/publish",
      steps: [{ kind: "upload", targetId: "media", inputKey: "mediaPaths" }],
    });
    const driver = new MemoryDriver();

    await expect(executeWorkflow(workflow, driver, {})).rejects.toMatchObject({
      details: { code: "INPUT_NOT_FOUND", workflowId: "publish.prepare" },
    });
    expect(driver.actions).toEqual([]);
  });

  it("clicks a target inside a closed shadow component", async () => {
    const workflow = defineWorkflow({
      id: "publish.submit",
      page,
      steps: [
        {
          kind: "click-closed-shadow",
          targetId: "submit",
          descendantTag: "button",
          descendantClass: "bg-red",
        },
      ],
    });
    const driver = new MemoryDriver();

    await executeWorkflow(workflow, driver, {});

    expect(driver.actions).toEqual(["shadow-click:submit:button:bg-red"]);
  });

  it("clicks a stable relative position inside a component host", async () => {
    const workflow = defineWorkflow({
      id: "publish.submit",
      page,
      steps: [
        {
          kind: "click-position",
          targetId: "submit",
          xRatio: 0.65,
          yRatio: 0.5,
        },
      ],
    });
    const driver = new MemoryDriver();

    await executeWorkflow(workflow, driver, {});

    expect(driver.actions).toEqual(["position-click:submit:0.65:0.5"]);
  });

  it("waits for the durable submission boundary before clicking", async () => {
    const workflow = defineWorkflow({
      id: "publish.submit",
      page,
      steps: [
        {
          kind: "click",
          targetId: "submit",
          commitBoundary: "submission",
        },
      ],
    });
    const driver = Object.assign(new MemoryDriver(), {
      prepareCommit: async () => {
        driver.actions.push("prepare-commit");
      },
    });

    await executeWorkflow(
      workflow,
      driver,
      {},
      {
        beforeCommit: async ({ workflowId, stepIndex, boundary }) => {
          driver.actions.push(`commit:${workflowId}:${stepIndex}:${boundary}`);
        },
      },
    );

    expect(driver.actions).toEqual([
      "prepare-commit",
      "commit:publish.submit:0:submission",
      "click:submit",
    ]);
  });

  it("skips an optional click when its target does not appear", async () => {
    const workflow = defineWorkflow({
      id: "publish.confirm",
      page,
      steps: [{ kind: "click-if-present", targetId: "submit", timeoutMs: 0 }],
    });
    const driver = new MemoryDriver();
    driver.query = async () => [];

    await executeWorkflow(workflow, driver, {});

    expect(driver.actions).toEqual([]);
  });

  it("adds workflow context and evidence to action failures", async () => {
    const workflow = defineWorkflow({
      id: "publish.prepare",
      page,
      steps: [{ kind: "fill", targetId: "body", inputKey: "body" }],
    });
    const driver = new MemoryDriver();
    driver.fill = async () => {
      throw new Error("page changed");
    };

    await expect(
      executeWorkflow(workflow, driver, { body: "正文" }),
    ).rejects.toMatchObject({
      details: {
        code: "ACTION_FAILED",
        workflowId: "publish.prepare",
        pageId: "publish",
        stepIndex: 0,
        targetId: "body",
        evidence: { id: "evidence-1" },
      },
    });
  });

  it("reports an ordered, value-free workflow trace", async () => {
    const workflow = defineWorkflow({
      id: "publish.prepare",
      page,
      steps: [{ kind: "fill", targetId: "body", inputKey: "body" }],
    });
    const driver = new MemoryDriver();
    const events: AutomationTraceEvent[] = [];
    let time = 0;

    await executeWorkflow(
      workflow,
      driver,
      { body: "不能写进日志的正文" },
      {
        trace: {
          executionId: "execution-1",
          report: (event) => events.push(event),
        },
        monotonicNow: () => time++,
      },
    );

    expect(events.map(({ type }) => type)).toEqual([
      "workflow.started",
      "step.started",
      "target.resolved",
      "step.completed",
      "workflow.completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "workflow.started",
      inputs: { body: { kind: "text", length: 9 } },
    });
    expect(JSON.stringify(events)).not.toContain("不能写进日志的正文");
  });

  it("keeps diagnostics failures outside workflow behavior", async () => {
    const workflow = defineWorkflow({
      id: "publish.submit",
      page,
      steps: [{ kind: "click", targetId: "submit" }],
    });
    const driver = new MemoryDriver();

    await executeWorkflow(
      workflow,
      driver,
      {},
      {
        trace: {
          executionId: "execution-1",
          report: () => {
            throw new Error("logger unavailable");
          },
        },
      },
    );

    expect(driver.actions).toEqual(["click:submit"]);
  });
});

describe("platform session detection", () => {
  it("uses one ordered probe model to extract account identity", async () => {
    const detection = defineSessionDetectionPlan({
      probes: [
        {
          identityScheme: "test.account_id",
          source: { kind: "request", url: "https://example.test/session" },
          fields: {
            externalAccountId: ["data", "id"],
            nickname: ["data", "name"],
          },
        },
      ],
    });
    const client: SessionProbeClient = {
      async fetchJson() {
        return {
          status: 200,
          ok: true,
          body: { data: { id: "user-42", name: "测试账号", followers: "12" } },
        };
      },
      async waitForJsonResponse() {
        return null;
      },
    };

    await expect(
      detectPlatformSession(detection, new MemoryDriver(), client),
    ).resolves.toEqual({
      status: "authenticated",
      identityScheme: "test.account_id",
      externalAccountId: "user-42",
      nickname: "测试账号",
      avatarUrl: null,
      source: "api",
    });
  });
});
