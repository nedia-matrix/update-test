import type {
  AutomationDriver,
  AutomationPage,
  AutomationWorkflow,
  WorkflowExecutionHooks,
  WorkflowInputs,
  WorkflowStep,
  TargetResolutionSummary,
  AutomationTraceEvent,
} from "./index.js";
import { summarizeWorkflowInputs } from "./automation-trace.js";

import { waitForCondition } from "./condition-evaluation.js";
import { AutomationError, type AutomationFailureDetails } from "./errors.js";
import { findTargetMatches, resolveTarget } from "./target-resolution.js";
import { validateWorkflowInputs } from "./workflow-definition.js";

interface StepExecutionResult {
  readonly outcome?: "absent";
}

function reportTrace(
  hooks: WorkflowExecutionHooks,
  event: AutomationTraceEvent,
): void {
  try {
    hooks.trace?.report(event);
  } catch {
    // Diagnostic output must not affect workflow execution.
  }
}

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function errorCode(error: unknown): AutomationFailureDetails["code"] {
  return error instanceof AutomationError
    ? error.details.code
    : "ACTION_FAILED";
}

function reportResolution(
  hooks: WorkflowExecutionHooks,
  workflowId: string,
  stepIndex: number,
  summary: TargetResolutionSummary,
): void {
  reportTrace(hooks, {
    type:
      summary.outcome === "resolved"
        ? "target.resolved"
        : "target.resolve_failed",
    workflowId,
    stepIndex,
    summary,
  });
}

function wait(
  driver: AutomationDriver,
  milliseconds: number | undefined,
): Promise<void> {
  return milliseconds && milliseconds > 0
    ? driver.wait(milliseconds)
    : Promise.resolve();
}

function stringInput(inputs: WorkflowInputs, key: string): string {
  const value = inputs[key];
  if (typeof value !== "string") {
    throw new AutomationError({
      code: "INPUT_NOT_FOUND",
      message: `Workflow input ${key} must be a string`,
    });
  }
  return value;
}

function stringListInput(
  inputs: WorkflowInputs,
  key: string,
): readonly string[] {
  const value = inputs[key];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new AutomationError({
      code: "INPUT_NOT_FOUND",
      message: `Workflow input ${key} must be a string list`,
    });
  }
  return value;
}

async function executeAppendTags(
  page: AutomationPage,
  step: Extract<WorkflowStep, { kind: "append-tags" }>,
  driver: AutomationDriver,
  inputs: WorkflowInputs,
  resolve: (
    targetId: string,
  ) => Promise<Awaited<ReturnType<typeof resolveTarget>>>,
): Promise<void> {
  const tags = stringListInput(inputs, step.inputKey);
  const body = stringInput(inputs, step.bodyInputKey);
  if (tags.length === 0) return;

  const target = await resolve(step.targetId);
  if (body.length > 0) await driver.pressKey(target, step.leadingKey);
  for (const [index, tag] of tags.entries()) {
    await driver.typeText(target, `#${tag}`, step.typingDelayMs);
    await wait(driver, step.suggestionWaitMs);
    await driver.pressKey(target, step.commitKey);
    await wait(driver, step.settleWaitMs);
    if (step.betweenText && index < tags.length - 1) {
      await driver.typeText(target, step.betweenText, step.typingDelayMs);
    }
  }
}

async function executeStep(
  page: AutomationPage,
  step: WorkflowStep,
  driver: AutomationDriver,
  inputs: WorkflowInputs,
  hooks: WorkflowExecutionHooks,
  stepIndex: number,
  workflowId: string,
): Promise<StepExecutionResult> {
  const now = hooks.monotonicNow ?? (() => Date.now());
  const resolve = (targetId: string) =>
    resolveTarget(
      driver,
      page,
      targetId,
      (summary) => reportResolution(hooks, workflowId, stepIndex, summary),
      now,
    );
  switch (step.kind) {
    case "click": {
      const target = await resolve(step.targetId);
      if (step.commitBoundary) {
        await driver.prepareCommit?.();
        reportTrace(hooks, {
          type: "commit.boundary_reached",
          workflowId,
          stepIndex,
          boundary: step.commitBoundary,
        });
        await hooks.beforeCommit?.({
          workflowId,
          stepIndex,
          boundary: step.commitBoundary,
        });
        reportTrace(hooks, {
          type: "commit.authorization_completed",
          workflowId,
          stepIndex,
          boundary: step.commitBoundary,
        });
      }
      await driver.click(target);
      return {};
    }
    case "click-position": {
      const target = await resolve(step.targetId);
      if (step.commitBoundary) {
        await driver.prepareCommit?.();
        reportTrace(hooks, {
          type: "commit.boundary_reached",
          workflowId,
          stepIndex,
          boundary: step.commitBoundary,
        });
        await hooks.beforeCommit?.({
          workflowId,
          stepIndex,
          boundary: step.commitBoundary,
        });
        reportTrace(hooks, {
          type: "commit.authorization_completed",
          workflowId,
          stepIndex,
          boundary: step.commitBoundary,
        });
      }
      await driver.clickAtPosition(target, step.xRatio, step.yRatio);
      return {};
    }
    case "click-if-present": {
      const deadline = Date.now() + step.timeoutMs;
      let lastResolution: TargetResolutionSummary | undefined;
      do {
        try {
          const target = await resolveTarget(
            driver,
            page,
            step.targetId,
            (summary) => {
              lastResolution = summary;
            },
            now,
          );
          if (lastResolution) {
            reportResolution(hooks, workflowId, stepIndex, lastResolution);
          }
          if (step.commitBoundary) {
            await driver.prepareCommit?.();
            reportTrace(hooks, {
              type: "commit.boundary_reached",
              workflowId,
              stepIndex,
              boundary: step.commitBoundary,
            });
            await hooks.beforeCommit?.({
              workflowId,
              stepIndex,
              boundary: step.commitBoundary,
            });
            reportTrace(hooks, {
              type: "commit.authorization_completed",
              workflowId,
              stepIndex,
              boundary: step.commitBoundary,
            });
          }
          await driver.click(target);
          return {};
        } catch (error) {
          if (
            !(error instanceof AutomationError) ||
            error.details.code !== "TARGET_NOT_FOUND"
          ) {
            throw error;
          }
        }
        await driver.wait(100);
      } while (Date.now() < deadline);
      if (lastResolution) {
        reportResolution(hooks, workflowId, stepIndex, lastResolution);
      }
      return { outcome: "absent" };
    }
    case "click-closed-shadow":
      await driver.clickClosedShadowDescendant(
        await resolve(step.targetId),
        step.descendantTag,
        step.descendantClass,
      );
      return {};
    case "fill":
      await driver.fill(
        await resolve(step.targetId),
        stringInput(inputs, step.inputKey),
      );
      return {};
    case "upload":
      await driver.uploadFiles(
        await resolve(step.targetId),
        stringListInput(inputs, step.inputKey),
      );
      return {};
    case "drop-files":
      await driver.dropFiles(
        await resolve(step.targetId),
        stringListInput(inputs, step.inputKey),
      );
      return {};
    case "append-tags":
      await executeAppendTags(page, step, driver, inputs, resolve);
      return {};
    case "wait-for-state": {
      const condition = page.states[step.stateId];
      if (
        !condition ||
        !(await waitForCondition(driver, page, condition, step.timeoutMs))
      ) {
        throw new AutomationError({
          code: "STATE_NOT_FOUND",
          message: condition
            ? `Timed out waiting for state ${step.stateId}`
            : `State ${step.stateId} is not defined on page ${page.id}`,
          pageId: page.id,
          stateId: step.stateId,
        });
      }
      return {};
    }
    case "wait-for-target-count": {
      const expectedItems = stringListInput(inputs, step.inputKey);
      const deadline = Date.now() + step.timeoutMs;
      let count = 0;
      let lastResolution: TargetResolutionSummary | undefined;
      do {
        count = (
          await findTargetMatches(
            driver,
            page,
            step.targetId,
            (summary) => {
              lastResolution = summary;
            },
            now,
          )
        ).length;
        if (count >= expectedItems.length) {
          if (lastResolution) {
            reportResolution(hooks, workflowId, stepIndex, lastResolution);
          }
          return {};
        }
        await wait(driver, 100);
      } while (Date.now() < deadline);
      if (lastResolution) {
        reportResolution(hooks, workflowId, stepIndex, lastResolution);
      }
      throw new AutomationError({
        code: "STATE_NOT_FOUND",
        message: `Timed out waiting for ${expectedItems.length} matches of ${step.targetId}; found ${count}`,
        pageId: page.id,
        targetId: step.targetId,
      });
    }
  }
}

interface ActiveAction {
  index?: number;
  kind: string;
  targetId?: string;
  stateId?: string;
}

function activeActionFor(index: number, step: WorkflowStep): ActiveAction {
  const action: ActiveAction = { index, kind: step.kind };
  if (step.kind === "wait-for-state") {
    action.stateId = step.stateId;
  } else {
    action.targetId = step.targetId;
  }
  return action;
}

function unexpectedFailureMessage(
  workflow: AutomationWorkflow,
  activeAction: ActiveAction | undefined,
  originalMessage: string,
): string {
  const actionKind = activeAction?.kind ?? "validation";
  let stepContext = "";
  if (activeAction?.index !== undefined) {
    stepContext = ` step ${activeAction.index + 1}`;
  }
  return `Workflow ${workflow.id}${stepContext} (${actionKind}) failed: ${originalMessage}`;
}

function failureDetails(
  workflow: AutomationWorkflow,
  activeAction: ActiveAction | undefined,
  error: unknown,
): AutomationFailureDetails {
  let details: AutomationFailureDetails;
  if (error instanceof AutomationError) {
    details = { ...error.details, message: error.message };
  } else {
    const originalMessage =
      error instanceof Error ? error.message : "Workflow action failed";
    details = {
      code: "ACTION_FAILED",
      message: unexpectedFailureMessage(
        workflow,
        activeAction,
        originalMessage,
      ),
    };
  }

  details.workflowId = workflow.id;
  details.pageId = workflow.page.id;
  if (activeAction?.index !== undefined) {
    details.stepIndex = activeAction.index;
  }
  if (activeAction?.targetId) details.targetId = activeAction.targetId;
  if (activeAction?.stateId) details.stateId = activeAction.stateId;
  return details;
}

async function createWorkflowFailure(
  workflow: AutomationWorkflow,
  activeAction: ActiveAction | undefined,
  driver: AutomationDriver,
  error: unknown,
  hooks: WorkflowExecutionHooks,
): Promise<AutomationError> {
  const failure = new AutomationError(
    failureDetails(workflow, activeAction, error),
  );
  try {
    failure.details.evidence = await driver.captureEvidence(failure.message);
    reportTrace(hooks, {
      type: "evidence.captured",
      workflowId: workflow.id,
      evidenceId: failure.details.evidence.id,
      capturedAt: failure.details.evidence.capturedAt,
      reasonCode: "workflow_failure",
      ...(failure.details.evidence.relativeRef
        ? { relativeRef: failure.details.evidence.relativeRef }
        : {}),
      ...(failure.details.evidence.mimeType
        ? { mimeType: failure.details.evidence.mimeType }
        : {}),
      ...(failure.details.evidence.byteSize === undefined
        ? {}
        : { byteSize: failure.details.evidence.byteSize }),
      ...(failure.details.evidence.width === undefined
        ? {}
        : { width: failure.details.evidence.width }),
      ...(failure.details.evidence.height === undefined
        ? {}
        : { height: failure.details.evidence.height }),
    });
  } catch (evidenceError) {
    reportTrace(hooks, {
      type: "evidence.capture_failed",
      workflowId: workflow.id,
      errorName:
        evidenceError instanceof Error ? evidenceError.name : "UnknownError",
    });
    // Evidence collection must not hide the original automation failure.
  }
  return failure;
}

export async function executeWorkflow(
  workflow: AutomationWorkflow,
  driver: AutomationDriver,
  inputs: WorkflowInputs,
  hooks: WorkflowExecutionHooks = {},
): Promise<void> {
  let activeAction: ActiveAction | undefined;
  const now = hooks.monotonicNow ?? (() => Date.now());
  const workflowStartedAt = now();
  reportTrace(hooks, {
    type: "workflow.started",
    workflowId: workflow.id,
    pageDefinitionId: workflow.page.id,
    stepCount: workflow.steps.length,
    inputs: summarizeWorkflowInputs(inputs),
  });
  try {
    validateWorkflowInputs(workflow, inputs);
    if (workflow.startUrl) {
      activeAction = { kind: "navigate" };
      const navigationStartedAt = now();
      reportTrace(hooks, {
        type: "navigation.started",
        workflowId: workflow.id,
        url: workflow.startUrl,
      });
      await driver.navigate(workflow.startUrl);
      reportTrace(hooks, {
        type: "navigation.completed",
        workflowId: workflow.id,
        url: workflow.startUrl,
        durationMs: elapsed(navigationStartedAt, now),
      });
    }
    for (const [index, step] of workflow.steps.entries()) {
      activeAction = activeActionFor(index, step);
      const activeStepStartedAt = now();
      const stepFields = {
        workflowId: workflow.id,
        stepIndex: index,
        stepKind: step.kind,
        ...(activeAction.targetId ? { targetId: activeAction.targetId } : {}),
        ...(activeAction.stateId ? { stateId: activeAction.stateId } : {}),
      };
      reportTrace(hooks, { type: "step.started", ...stepFields });
      try {
        const result = await executeStep(
          workflow.page,
          step,
          driver,
          inputs,
          hooks,
          index,
          workflow.id,
        );
        reportTrace(hooks, {
          type: "step.completed",
          ...stepFields,
          durationMs: elapsed(activeStepStartedAt, now),
          ...(result.outcome ? { outcome: result.outcome } : {}),
        });
      } catch (error) {
        reportTrace(hooks, {
          type: "step.failed",
          ...stepFields,
          durationMs: elapsed(activeStepStartedAt, now),
          code: errorCode(error),
        });
        throw error;
      }
    }
    reportTrace(hooks, {
      type: "workflow.completed",
      workflowId: workflow.id,
      durationMs: elapsed(workflowStartedAt, now),
    });
  } catch (error) {
    const failure = await createWorkflowFailure(
      workflow,
      activeAction,
      driver,
      error,
      hooks,
    );
    reportTrace(hooks, {
      type: "workflow.failed",
      workflowId: workflow.id,
      pageDefinitionId: workflow.page.id,
      durationMs: elapsed(workflowStartedAt, now),
      code: failure.details.code,
      message: failure.message,
      ...(failure.details.stepIndex === undefined
        ? {}
        : { stepIndex: failure.details.stepIndex }),
      ...(activeAction?.kind ? { stepKind: activeAction.kind } : {}),
      ...(failure.details.targetId
        ? { targetId: failure.details.targetId }
        : {}),
      ...(failure.details.stateId ? { stateId: failure.details.stateId } : {}),
      ...(failure.details.evidence?.id
        ? { evidenceId: failure.details.evidence.id }
        : {}),
    });
    throw failure;
  }
}
