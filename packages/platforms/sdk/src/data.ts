/** Operational failures that can end pagination while retaining verified pages.
 * Cancellation, boundary violations and response validation errors are excluded.
 */
export class PlatformDataOperationError extends Error {
  readonly retryAfterMs?: number;
  constructor(
    readonly code: "rate_limited" | "request_failed" | "scroll_failed",
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
    this.name = "PlatformDataOperationError";
  }
  get userMessage(): string {
    return {
      rate_limited: "平台请求受限，请稍后重新同步",
      request_failed: "网络请求失败，请稍后重新同步",
      scroll_failed: "页面滚动失败，请重新打开平台页面后同步",
    }[this.code];
  }
}

export interface PlatformJsonResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  readonly retryAfterMs?: number;
}

export interface PlatformJsonRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface PlatformObservedJsonRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly timeoutMs: number;
  readonly replayObserved?: boolean;
}

export interface PlatformScrollRequest {
  readonly selector: string;
}

export interface PlatformScrollResult {
  readonly found: boolean;
  readonly moved: boolean;
  readonly atEnd: boolean;
}

export interface PlatformDataClient {
  navigate(url: string): Promise<void>;
  navigateForJsonResponses?(request: {
    readonly url: string;
    readonly responses: readonly PlatformObservedJsonRequest[];
  }): Promise<readonly (PlatformJsonResponse | null)[]>;
  requestJson(request: PlatformJsonRequest): Promise<PlatformJsonResponse>;
  waitForJsonResponse(
    request: PlatformObservedJsonRequest,
  ): Promise<PlatformJsonResponse | null>;
  scrollToEnd(request: PlatformScrollRequest): Promise<PlatformScrollResult>;
  scrollForJsonResponse?(
    request: PlatformScrollRequest & {
      readonly response: PlatformObservedJsonRequest;
    },
  ): Promise<{
    readonly scroll: PlatformScrollResult;
    readonly response: PlatformJsonResponse | null;
  }>;
  dispose(): void;
}

export async function navigateForJsonResponses(
  client: PlatformDataClient,
  url: string,
  requests: readonly PlatformObservedJsonRequest[],
): Promise<readonly (PlatformJsonResponse | null)[]> {
  if (client.navigateForJsonResponses)
    return client.navigateForJsonResponses({ url, responses: requests });
  const responses = Promise.all(
    requests.map((request) => client.waitForJsonResponse(request)),
  );
  await client.navigate(url);
  return responses;
}

/** Lets native adapters coordinate wheel input with the response that stops it. */
export async function scrollForNextJsonResponse(
  client: PlatformDataClient,
  request: PlatformScrollRequest & {
    readonly response: PlatformObservedJsonRequest;
  },
): Promise<{
  readonly scroll: PlatformScrollResult;
  readonly response: PlatformJsonResponse | null;
}> {
  if (client.scrollForJsonResponse)
    return client.scrollForJsonResponse(request);
  const response = client.waitForJsonResponse(request.response);
  const scroll = await client.scrollToEnd({ selector: request.selector });
  return { scroll, response: await response };
}

export interface PlatformAccountProfileData {
  readonly description?: string;
  readonly followerCount?: number;
  readonly followingCount?: number;
  readonly contentCount?: number;
  readonly likeCount?: number;
}

export interface PlatformAccountProfileCapability {
  readonly implementationStatus:
    "route-only" | "reference-derived" | "fixture-tested" | "live-tested";
  read(client: PlatformDataClient): Promise<PlatformAccountProfileData>;
}

export interface PlatformContentMetricsData {
  readonly viewCount?: number;
  readonly likeCount?: number;
  readonly commentCount?: number;
  readonly shareCount?: number;
  readonly collectCount?: number;
}

export interface PlatformContentData {
  readonly externalContentId: string;
  readonly contentUrl?: string;
  readonly contentType: "video" | "image_text" | "unknown";
  readonly title?: string;
  readonly description?: string;
  readonly coverUrl?: string;
  readonly publishedAt?: string;
  readonly platformStatus?: string;
  readonly metrics: PlatformContentMetricsData;
}

export interface PlatformContentReadResult {
  readonly failure?: PlatformSyncFailure;
  readonly items: readonly PlatformContentData[];
  /** True only after reading the entire account inventory, never just a filtered or partial page set. */
  readonly complete: boolean;
  readonly pagesRead: number;
  readonly remoteTotal?: number;
  readonly diagnostics?: readonly string[];
}

export interface PlatformContentCapability {
  readonly implementationStatus:
    "route-only" | "reference-derived" | "fixture-tested" | "live-tested";
  read(
    client: PlatformDataClient,
    expectedExternalAccountId: string,
    options?: {
      /** Await persistence before requesting the next page. Items are this page only. */
      readonly onPage?: (page: {
        readonly items: readonly PlatformContentData[];
        readonly pagesRead: number;
        readonly remoteTotal?: number;
      }) => Promise<void>;
    },
  ): Promise<PlatformContentReadResult>;
}

/** Structural contract survives independently bundled SDK copies. */
export function isPlatformDataOperationError(
  value: unknown,
): value is PlatformDataOperationError {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Record<string, unknown>;
  return (
    error.name === "PlatformDataOperationError" &&
    typeof error.message === "string" &&
    ["rate_limited", "request_failed", "scroll_failed"].includes(
      String(error.code),
    )
  );
}

/** Stable application-facing sync failure; messages are presentation, never classifiers. */
export interface PlatformSyncFailure {
  code:
    | "authentication"
    | "identity_mismatch"
    | "verification_required"
    | "request_failed"
    | "rate_limited"
    | "scroll_failed"
    | "unsupported"
    | "persistence_failed"
    | "resource_close_failed"
    | "read_failed";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  resourcesClosed?: boolean;
}
export class PlatformSyncError extends Error {
  constructor(
    readonly failure: PlatformSyncFailure,
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
    this.name = "PlatformSyncError";
  }
}
export function platformSyncFailure(error: unknown): PlatformSyncFailure {
  if (error instanceof PlatformSyncError) return error.failure;
  // Plugins may bundle their own SDK copy; preserve the structured failure across that boundary.
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "PlatformSyncError" &&
    "failure" in error
  ) {
    const failure = error.failure as PlatformSyncFailure;
    if (
      failure &&
      typeof failure.code === "string" &&
      typeof failure.message === "string" &&
      typeof failure.retryable === "boolean"
    )
      return failure;
  }
  if (isPlatformDataOperationError(error))
    return {
      code: error.code,
      message: error.userMessage,
      retryable: error.code !== "scroll_failed",
      ...(typeof (error as { retryAfterMs?: number }).retryAfterMs === "number"
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    };
  return {
    code: "read_failed",
    message: error instanceof Error ? error.message : "同步失败",
    retryable: false,
  };
}

/** Translate transport status without inspecting localized messages or response secrets. */
export function platformSyncResponseError(
  response:
    Pick<PlatformJsonResponse, "status" | "retryAfterMs"> | null | undefined,
  message: string,
): PlatformSyncError {
  const status = response?.status;
  return new PlatformSyncError({
    code:
      status === 401
        ? "authentication"
        : status === 403
          ? "verification_required"
          : status === 429
            ? "rate_limited"
            : "request_failed",
    message,
    retryable: status !== 401 && status !== 403,
    ...(response?.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: response.retryAfterMs }),
  });
}
