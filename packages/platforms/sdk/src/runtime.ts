import type { PublishContentForm } from "./publishing.js";

export type Unsubscribe = () => void;

export interface ObservedHttpResponse {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readText(maxBytes: number): Promise<string>;
}

export interface ObservedHttpRequest {
  readonly method: string;
  readonly url: string;
}

export interface RequestStream {
  subscribe(listener: (request: ObservedHttpRequest) => void): Unsubscribe;
}

export interface ResponseStream {
  subscribe(listener: (response: ObservedHttpResponse) => void): Unsubscribe;
}

export interface ObservationPage {
  isTextVisible(text: string): Promise<boolean>;
  subscribeClose(listener: () => void): Unsubscribe;
}

export interface ObservationClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface PublishObservationSession {
  requests?: RequestStream;
  responses: ResponseStream;
  page: ObservationPage;
}

export interface PublishMonitorContext {
  readonly settings?: import("./settings.js").PlatformSettings;
  contentForm: PublishContentForm;
  submissionMode?: "automatic" | "manual_confirmation";
  session: PublishObservationSession;
  clock: ObservationClock;
  diagnostics: PublishMonitorDiagnostics;
}

export type PublishMonitorDiagnosticStage = "response" | "page";

export interface PublishMonitorDiagnostic {
  stage: PublishMonitorDiagnosticStage;
  code: string;
  message: string;
}

export interface PublishMonitorDiagnostics {
  report(diagnostic: PublishMonitorDiagnostic): void;
}

export const publishResultKinds = [
  "submission_attempted",
  "verification_required",
  "verifying",
  "published",
  "failed",
  "uncertain",
  "cancelled",
] as const;

export type PublishResultKind = (typeof publishResultKinds)[number];

export type PublishResultEvent =
  | {
      kind: "submission_attempted";
      source: "application_commit" | "page_request";
      message: string;
    }
  | { kind: "verification_required"; message: string }
  | { kind: "verifying"; message: string }
  | { kind: "published"; contentId: string | null; contentUrl: string | null }
  | { kind: "failed"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "cancelled"; message: string };

export type PublishInterruptionReason =
  "page_closed" | "observation_interrupted" | "desktop_shutdown";

export interface PublishResultMonitor {
  subscribe(listener: (event: PublishResultEvent) => void): Unsubscribe;
  ready(): Promise<void>;
  arm(): void;
  submissionAttempted(): void;
  interrupt(reason: PublishInterruptionReason): Promise<void>;
  stop(): void;
}

export type PublishMonitorState =
  "observing_draft" | "armed" | "verifying" | "completed";

export class PublishMonitorLifecycle {
  private currentState: PublishMonitorState = "observing_draft";

  get state(): PublishMonitorState {
    return this.currentState;
  }

  arm(): boolean {
    if (this.currentState !== "observing_draft") return false;
    this.currentState = "armed";
    return true;
  }

  beginVerification(): boolean {
    if (this.currentState !== "armed") return false;
    this.currentState = "verifying";
    return true;
  }

  requireVerification(): boolean {
    if (this.currentState !== "armed" && this.currentState !== "verifying") {
      return false;
    }
    this.currentState = "armed";
    return true;
  }

  complete(): boolean {
    if (this.currentState === "completed") return false;
    this.currentState = "completed";
    return true;
  }
}

export interface PlatformPublishRuntime {
  createResultMonitor(context: PublishMonitorContext): PublishResultMonitor;
}

export type DirectPublishResult = Extract<
  PublishResultEvent,
  { kind: "published" | "failed" | "uncertain" | "cancelled" }
>;
/** Structural cancellation contract keeps the SDK usable in non-DOM platform packages. */
export interface PublishAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Task-scoped adapter. Prepared material stays in the adapter, never in domain state. */
export interface PluginPublishSession {
  prepare(
    input: {
      title: string;
      body: string;
      mediaReferences: readonly string[];
      tags: readonly string[];
    },
    signal: PublishAbortSignal,
  ): Promise<void>;
  /** Await the durable application commit immediately before sending the one creation request. */
  submit(input: {
    signal: PublishAbortSignal;
    beforeCommit(): Promise<void>;
  }): Promise<DirectPublishResult>;
  close(): Promise<void>;
}
