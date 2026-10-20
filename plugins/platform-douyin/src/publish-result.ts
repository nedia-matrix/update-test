import { buildDouyinContentUrl } from "./content-url.js";

export type DouyinPublishContentForm = "video" | "imageText";

export interface DouyinPublishResponse {
  method: string;
  url: string;
  httpStatus: number;
  body: unknown;
}

export type DouyinPublishSignal =
  | { kind: "ignore" }
  | { kind: "verification_required"; message: string | null }
  | { kind: "accepted"; message: string | null }
  | {
      kind: "published";
      postId: string | null;
      postUrl: string | null;
    }
  | { kind: "failed"; error: string };

const publishPath = /^\/web\/api\/media\/aweme\/create_v2\/?$/i;
const verificationPattern =
  /短信|验证码|手机验证|安全验证|身份验证|风险验证|风控|captcha|verification|verify/i;
const identityPattern = /^[A-Za-z0-9_-]{8,}$/;

function responseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function endpointKind(response: DouyinPublishResponse): "publish" | null {
  const parsed = response.url.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (!parsed) return null;
  const hostname = (parsed[1] ?? "").toLowerCase().split(":", 1)[0] ?? "";
  const pathname = parsed[2] ?? "/";
  if (hostname !== "douyin.com" && !hostname.endsWith(".douyin.com")) {
    return null;
  }

  if (response.method.toUpperCase() === "POST" && publishPath.test(pathname)) {
    return "publish";
  }
  return null;
}

export function isDouyinPublishResponseCandidate(
  response: Pick<DouyinPublishResponse, "method" | "url">,
): boolean {
  return endpointKind({ ...response, httpStatus: 0, body: null }) !== null;
}

export function classifyDouyinPublishResponse(
  response: DouyinPublishResponse,
  contentForm: DouyinPublishContentForm,
): DouyinPublishSignal {
  if (!endpointKind(response)) return { kind: "ignore" };

  const body = responseBody(response.body);
  const postId = isRecord(body) ? scalarString(body.item_id) : null;
  const message = isRecord(body)
    ? (scalarString(body.status_msg) ??
      scalarString(body.message) ??
      scalarString(body.msg))
    : null;
  const statusCode = isRecord(body) ? scalarString(body.status_code) : null;

  if (message && verificationPattern.test(message) && !postId) {
    return { kind: "verification_required", message };
  }
  if (postId && identityPattern.test(postId)) {
    return {
      kind: "published",
      postId,
      postUrl: buildDouyinContentUrl(
        postId,
        contentForm === "imageText" ? "image_text" : "video",
      ),
    };
  }
  if (
    response.httpStatus >= 400 ||
    (statusCode !== null && statusCode !== "0")
  ) {
    return {
      kind: "failed",
      error:
        message ?? `抖音发布接口返回状态 ${statusCode ?? response.httpStatus}`,
    };
  }
  if (statusCode === "0") return { kind: "accepted", message };
  return { kind: "ignore" };
}
