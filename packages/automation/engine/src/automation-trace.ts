import type { AutomationFailureDetails } from "./errors.js";
import type { ElementState, LocatorCandidate } from "./driver.js";
import type { WorkflowInputs, WorkflowStep } from "./workflow.js";

export type AutomationInputSummary = Readonly<
  Record<
    string,
    | { readonly kind: "text"; readonly length: number }
    | { readonly kind: "string-list"; readonly count: number }
  >
>;

export interface TargetResolutionSummary {
  readonly targetId: string;
  readonly selectedCandidateIndex?: number;
  readonly selectedCandidateKind?: LocatorCandidate["kind"];
  readonly attemptedCandidates: number;
  readonly matchCount: number;
  readonly elementState?: ElementState;
  readonly outcome: "resolved" | "not_found" | "ambiguous" | "condition_failed";
  readonly durationMs: number;
}

interface WorkflowTraceFields {
  readonly workflowId: string;
}

interface StepTraceFields extends WorkflowTraceFields {
  readonly stepIndex: number;
  readonly stepKind: WorkflowStep["kind"];
  readonly targetId?: string;
  readonly stateId?: string;
}

export type AutomationTraceEvent =
  | (WorkflowTraceFields & {
      readonly type: "workflow.started";
      readonly pageDefinitionId: string;
      readonly stepCount: number;
      readonly inputs: AutomationInputSummary;
    })
  | (WorkflowTraceFields & {
      readonly type: "navigation.started";
      readonly url: string;
    })
  | (WorkflowTraceFields & {
      readonly type: "navigation.completed";
      readonly url: string;
      readonly durationMs: number;
    })
  | (StepTraceFields & { readonly type: "step.started" })
  | (StepTraceFields & {
      readonly type: "step.completed";
      readonly durationMs: number;
      readonly outcome?: "absent";
    })
  | (StepTraceFields & {
      readonly type: "step.failed";
      readonly durationMs: number;
      readonly code: AutomationFailureDetails["code"];
    })
  | (WorkflowTraceFields & {
      readonly type: "target.resolved" | "target.resolve_failed";
      readonly stepIndex: number;
      readonly summary: TargetResolutionSummary;
    })
  | (WorkflowTraceFields & {
      readonly type:
        "commit.boundary_reached" | "commit.authorization_completed";
      readonly stepIndex: number;
      readonly boundary: "submission";
    })
  | (WorkflowTraceFields & {
      readonly type: "evidence.captured";
      readonly evidenceId: string;
      readonly capturedAt: string;
      readonly reasonCode: "workflow_failure";
      readonly mimeType?: string;
      readonly byteSize?: number;
      readonly relativeRef?: string;
      readonly width?: number;
      readonly height?: number;
    })
  | (WorkflowTraceFields & {
      readonly type: "evidence.capture_failed";
      readonly errorName: string;
    })
  | (WorkflowTraceFields & {
      readonly type: "workflow.completed";
      readonly durationMs: number;
    })
  | (WorkflowTraceFields & {
      readonly type: "workflow.failed";
      readonly pageDefinitionId: string;
      readonly durationMs: number;
      readonly code: AutomationFailureDetails["code"];
      readonly message: string;
      readonly stepIndex?: number;
      readonly stepKind?: string;
      readonly targetId?: string;
      readonly stateId?: string;
      readonly evidenceId?: string;
    });

export interface AutomationExecutionTrace {
  readonly executionId: string;
  report(event: AutomationTraceEvent): void;
}

export type TargetResolutionObserver = (
  summary: TargetResolutionSummary,
) => void;

export function summarizeWorkflowInputs(
  inputs: WorkflowInputs,
): AutomationInputSummary {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [
      key,
      typeof value === "string"
        ? { kind: "text" as const, length: value.length }
        : { kind: "string-list" as const, count: value.length },
    ]),
  );
}
