import { randomUUID } from "node:crypto";
import type { DiagnosticLevel, DiagnosticStore } from "./record.js";

export interface DiagnosticTraceContext {
  readonly operation: string;
  readonly platformId?: string;
  readonly accountId?: string;
  readonly requestId?: string;
  readonly environment?: Readonly<Record<string, unknown>>;
}
export interface DiagnosticTraceBinding {
  platformId?: string;
  accountId?: string;
  requestId?: string;
  publicationId?: string;
  pageId?: string;
}
export interface DiagnosticEvent {
  component: string;
  event: string;
  level?: DiagnosticLevel;
  executionId?: string;
  workflowId?: string;
  details?: Readonly<Record<string, unknown>>;
  attachmentIds?: readonly string[];
}
export interface DiagnosticTrace {
  readonly traceId: string;
  bind(binding: DiagnosticTraceBinding): void;
  report(event: DiagnosticEvent): void;
  finish(input: { outcome: string; message?: string }): void;
}

interface State {
  sequence: number;
  finished: boolean;
  finishedAt?: number;
  context: DiagnosticTraceContext & DiagnosticTraceBinding;
}
const FINISHED_TRACE_TTL_MS = 30 * 60 * 1_000;
const MAX_FINISHED_TRACES = 1_024;

export class DiagnosticTraceService {
  private readonly traces = new Map<string, State>();
  private readonly publicationIndex = new Map<string, string>();
  constructor(
    private readonly store: DiagnosticStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(context: DiagnosticTraceContext): DiagnosticTrace {
    this.pruneFinished();
    const traceId = randomUUID();
    const state: State = {
      sequence: 0,
      finished: false,
      context: { ...context },
    };
    this.traces.set(traceId, state);
    const trace = this.handle(traceId, state);
    trace.report({
      component: "application",
      event: "trace.started",
      details: context.environment,
    });
    return trace;
  }
  findTraceForPublication(id: string) {
    return this.publicationIndex.get(id)
      ? Promise.resolve(this.publicationIndex.get(id)!)
      : this.store.findTraceForPublication(id);
  }
  readTrace(id: string, limit?: number, afterSequence?: number) {
    return this.store.readTrace(id, limit, afterSequence);
  }
  flush() {
    return this.store.flush();
  }
  close() {
    return this.store.close();
  }
  activeTraceIds(): ReadonlySet<string> {
    return new Set(
      [...this.traces].filter(([, state]) => !state.finished).map(([id]) => id),
    );
  }
  reportDroppedRecords(
    traceId: string,
    counts: Readonly<Record<DiagnosticLevel, number>>,
  ) {
    const state = this.traces.get(traceId);
    if (!state) return;
    this.report(traceId, state, {
      component: "logger",
      event: "logger.records_dropped",
      level: "warn",
      details: {
        count: Object.values(counts).reduce((sum, n) => sum + n, 0),
        ...counts,
      },
    });
  }

  protected report(
    traceId: string,
    state: State,
    event: DiagnosticEvent,
  ): void {
    const sequence = ++state.sequence;
    const context = state.context;
    this.store.report({
      timestamp: this.now().toISOString(),
      level: event.level ?? "info",
      sequence,
      traceId,
      eventId: randomUUID(),
      operation: context.operation,
      component: event.component,
      event: event.event,
      ...(event.executionId ? { executionId: event.executionId } : {}),
      ...(context.platformId ? { platformId: context.platformId } : {}),
      ...(context.accountId ? { accountId: context.accountId } : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.publicationId
        ? { publicationId: context.publicationId }
        : {}),
      ...(context.pageId ? { pageId: context.pageId } : {}),
      ...(event.workflowId ? { workflowId: event.workflowId } : {}),
      ...(event.attachmentIds ? { attachmentIds: event.attachmentIds } : {}),
      ...(event.details
        ? {
            details: {
              ...event.details,
              ...(state.finished ? { late: true } : {}),
            },
          }
        : state.finished
          ? { details: { late: true } }
          : {}),
    });
  }

  private handle(traceId: string, state: State): DiagnosticTrace {
    return {
      traceId,
      bind: (binding) => {
        if (state.finished) return;
        state.context = { ...state.context, ...binding };
        // The publication lookup opens the publishing timeline. Secondary
        // traces (notices and persistence retries) must not replace it.
        if (
          binding.publicationId &&
          state.context.operation === "publication.prepare"
        )
          this.publicationIndex.set(binding.publicationId, traceId);
      },
      report: (event) => this.report(traceId, state, event),
      finish: ({ outcome, message }) => {
        if (state.finished) return;
        this.report(traceId, state, {
          component: "application",
          event: outcome === "failed" ? "trace.failed" : "trace.completed",
          level: outcome === "failed" ? "error" : "info",
          details: { outcome, ...(message ? { message } : {}) },
        });
        state.finished = true;
        state.finishedAt = this.now().getTime();
      },
    };
  }
  private pruneFinished() {
    const cutoff = this.now().getTime() - FINISHED_TRACE_TTL_MS;
    const finished = [...this.traces].filter(([, state]) => state.finished);
    for (const [id, state] of finished)
      if ((state.finishedAt ?? 0) < cutoff) this.remove(id);
    const remaining = [...this.traces].filter(([, state]) => state.finished);
    for (const [id] of remaining.slice(
      0,
      Math.max(0, remaining.length - MAX_FINISHED_TRACES),
    ))
      this.remove(id);
  }
  private remove(traceId: string) {
    this.traces.delete(traceId);
    for (const [publicationId, id] of this.publicationIndex)
      if (id === traceId) this.publicationIndex.delete(publicationId);
  }
}
