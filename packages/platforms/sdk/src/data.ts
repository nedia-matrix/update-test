/** Operational failures that can end pagination while retaining verified pages.
 * Cancellation, boundary violations and response validation errors are excluded.
 */
export class PlatformDataOperationError extends Error {
  constructor(
    readonly code: "rate_limited" | "request_failed" | "scroll_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  readonly items: readonly PlatformContentData[];
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
  ): Promise<PlatformContentReadResult>;
}
