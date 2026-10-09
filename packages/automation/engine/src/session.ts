import type { AutomationPage, TargetId } from "./workflow.js";

export type FieldPath = readonly (string | number)[];

export interface SessionAccountFields {
  readonly externalAccountId: FieldPath;
  readonly nickname: FieldPath;
  readonly avatarUrl?: FieldPath;
}

export type SessionProbeSource =
  | { readonly kind: "request"; readonly url: string }
  | {
      readonly kind: "observed-response";
      readonly method: "GET" | "POST";
      readonly url: string;
      readonly timeoutMs: number;
    };

export interface SessionProbe {
  readonly identityScheme: string;
  readonly source: SessionProbeSource;
  readonly fields: SessionAccountFields;
}

export interface DomSessionFallback {
  readonly identityScheme: string;
  readonly page: AutomationPage;
  readonly loggedOutTargetId: TargetId;
  readonly nicknameTargetId: TargetId;
  readonly accountIdTargetId: TargetId;
  readonly accountIdAttributes: readonly string[];
}

export interface SessionDetectionPlan {
  readonly probes: readonly SessionProbe[];
  readonly loggedOutUrl?: string;
  readonly domFallback?: DomSessionFallback;
}

export interface SessionProbeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

export interface SessionProbeClient {
  fetchJson(url: string): Promise<SessionProbeResponse>;
  waitForJsonResponse(request: {
    method: "GET" | "POST";
    url: string;
    timeoutMs: number;
  }): Promise<SessionProbeResponse | null>;
}

export type PlatformSessionDetection =
  | {
      readonly status: "authenticated";
      readonly identityScheme: string;
      readonly externalAccountId: string;
      readonly nickname: string;
      readonly avatarUrl: string | null;
      readonly source: "api" | "response" | "dom";
    }
  | {
      readonly status: "login_required";
      readonly source: "api" | "response" | "dom";
    }
  | { readonly status: "unknown"; readonly reason: string };
