import { randomUUID } from "node:crypto";
import type {
  AutomationExecutionTrace,
  AutomationTraceEvent,
} from "@nedia-matrix/automation-engine";
import {
  DiagnosticTraceService,
  type DiagnosticEvent,
  type DiagnosticLevel,
  type DiagnosticStore,
  type DiagnosticTrace,
} from "@nedia-matrix/diagnostics";

export interface DesktopDiagnosticTraceStartContext {
  readonly operation: string;
  readonly platformId?: string;
  readonly accountId?: string;
  readonly requestId?: string;
  readonly environment?: Readonly<Record<string, unknown>>;
}

export interface DesktopDiagnosticTrace extends DiagnosticTrace {
  execution(phase: string): AutomationExecutionTrace;
}

/** Compatibility adapter for automation event producers. */
export class DesktopDiagnosticTraceService {
  private readonly diagnostics: DiagnosticTraceService;

  constructor(sink: DiagnosticStore, now: () => Date = () => new Date()) {
    this.diagnostics = new DiagnosticTraceService(sink, now);
  }

  start(context: DesktopDiagnosticTraceStartContext): DesktopDiagnosticTrace {
    const trace = this.diagnostics.start(context);
    return {
      ...trace,
      execution: (phase) => {
        const executionId = randomUUID();
        return {
          executionId,
          report: (event) =>
            trace.report(mapEngineEvent(event, executionId, phase)),
        };
      },
    };
  }

  findTraceForPublication(publicationId: string): Promise<string | null> {
    return this.diagnostics.findTraceForPublication(publicationId);
  }

  readTrace(traceId: string, limit?: number, afterSequence?: number) {
    return this.diagnostics.readTrace(traceId, limit, afterSequence);
  }

  flush(): Promise<void> {
    return this.diagnostics.flush();
  }

  close(): Promise<void> {
    return this.diagnostics.close();
  }

  activeTraceIds(): ReadonlySet<string> {
    return this.diagnostics.activeTraceIds();
  }

  reportDroppedRecords(
    traceId: string,
    counts: Readonly<Record<DiagnosticLevel, number>>,
  ): void {
    this.diagnostics.reportDroppedRecords(traceId, counts);
  }
}

function mapEngineEvent(
  event: AutomationTraceEvent,
  executionId: string,
  phase: string,
): DiagnosticEvent {
  const details: Record<string, unknown> = { phase };
  for (const [key, value] of Object.entries(event)) {
    if (key === "type" || key === "workflowId") continue;
    details[key] = value;
  }
  return {
    component: event.type.startsWith("evidence.") ? "evidence" : "workflow",
    event: event.type,
    executionId,
    workflowId: event.workflowId,
    level: levelForEngineEvent(event),
    details,
    ...("evidenceId" in event && event.evidenceId
      ? { attachmentIds: [event.evidenceId] }
      : {}),
  };
}

function levelForEngineEvent(event: AutomationTraceEvent): DiagnosticLevel {
  if (event.type.endsWith("failed")) return "error";
  if (event.type === "evidence.capture_failed") return "warn";
  if (event.type.startsWith("target.")) return "debug";
  return "info";
}
