import type { PublicationSummary } from "@nedia-matrix/publishing";

import type { RemotePublicationAsset } from "@nedia-matrix/publishing";

export interface RuntimePublicationRequest {
  requestId: string;
  platform: string;
  externalAccountId: string;
  contentForm: "imageText" | "video";
  title: string;
  body: string;
  tags: readonly string[];
  assets: readonly RemotePublicationAsset[];
}

export function parseRuntimePublicationRequest(
  value: Record<string, unknown>,
): RuntimePublicationRequest {
  const target = requireRecord(value.target, "target");
  // External execution and submission hints are ignored; Desktop owns the policy.
  const content = requireRecord(value.content, "content");
  const requestId = requireString(value.requestId, "requestId");
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(requestId)) {
    throw new TypeError("Invalid publication requestId");
  }
  const platform = requireBoundedString(
    target.platform,
    "target.platform",
    128,
  );
  if (
    target.platformAccountId !== undefined ||
    target.runtimeAccountId !== undefined
  ) {
    throw new TypeError(
      "Publication target must use externalAccountId; local and Web account IDs are not accepted",
    );
  }
  const externalAccountId = requireBoundedString(
    target.externalAccountId,
    "target.externalAccountId",
    128,
  );
  const contentForm = target.contentForm;
  if (contentForm !== "image_text" && contentForm !== "video") {
    throw new TypeError("Unsupported publication content form");
  }
  if (value.scheduledTime !== undefined) {
    throw new TypeError("Scheduled Desktop publication is not supported");
  }
  if (content.cover !== undefined) {
    throw new TypeError("Desktop publication cover upload is not supported");
  }
  const title = requireString(content.title, "content.title", true);
  const body = parseBody(content.body);
  const tags = parseTags(content.tags);
  const assets =
    contentForm === "video"
      ? [parseAsset(content.video, "video", 0)]
      : parseImageAssets(content.images);
  return {
    requestId,
    platform,
    externalAccountId,
    contentForm: contentForm === "image_text" ? "imageText" : "video",
    title,
    body,
    tags,
    assets,
  };
}

export function runtimePublicationStatus(summary: PublicationSummary) {
  const state = runtimeState(summary.state);
  const contentForm =
    summary.contentForm === "imageText" ? "image_text" : "video";
  const terminal =
    state === "published" ||
    state === "failed" ||
    state === "uncertain" ||
    state === "cancelled";
  return {
    requestId: summary.requestId,
    state,
    ...(summary.lastMessage ? { progress: summary.lastMessage } : {}),
    ...(terminal
      ? {
          result: {
            platform: summary.platformId,
            contentForm,
            state,
            ok: state === "published",
            ...(state === "published"
              ? {}
              : {
                  error:
                    summary.lastMessage ??
                    "Desktop publication did not complete",
                  errorCode:
                    state === "uncertain"
                      ? "publish_status_unknown"
                      : state === "cancelled"
                        ? "publish_cancelled"
                        : "publish_failed",
                  retryable: state === "cancelled",
                }),
            platformPostId: summary.platformContentId,
            platformPostUrl: summary.platformContentUrl,
          },
        }
      : {}),
  };
}

export function runtimePublicationEvent(summary: PublicationSummary) {
  const status = runtimePublicationStatus(summary);
  return status.result
    ? {
        type: "runtime.publish.result" as const,
        requestId: summary.requestId,
        result: status.result,
      }
    : {
        type: "runtime.publish.progress" as const,
        requestId: summary.requestId,
        state: status.state,
        text: status.progress ?? "Desktop 发布状态已更新",
      };
}

function runtimeState(state: PublicationSummary["state"]) {
  if (state === "draft" || state === "validated" || state === "scheduled") {
    return "accepted" as const;
  }
  if (state === "retrying") return "preparing" as const;
  if (state === "rejected") return "failed" as const;
  return state;
}

function parseImageAssets(value: unknown): RemotePublicationAsset[] {
  if (!Array.isArray(value))
    throw new TypeError("content.images must be an array");
  return value.map((asset, order) => parseAsset(asset, "image", order));
}

function parseAsset(
  value: unknown,
  role: "image" | "video",
  order: number,
): RemotePublicationAsset {
  const asset = requireRecord(value, `content.${role}`);
  const mediaType = requireString(asset.type, `content.${role}.type`);
  if (
    !["image/jpeg", "image/png", "image/webp", "video/mp4"].includes(mediaType)
  ) {
    throw new TypeError("Unsupported remote asset media type");
  }
  return {
    url: requireString(asset.url, `content.${role}.url`),
    name: requireString(asset.name, `content.${role}.name`),
    mediaType: mediaType as RemotePublicationAsset["mediaType"],
    role,
    order,
    ...(typeof asset.assetId === "string"
      ? { sourceAssetId: asset.assetId }
      : {}),
  };
}

function parseBody(value: unknown): string {
  if (value === undefined) return "";
  const body = requireRecord(value, "content.body");
  if (body.type === "plain_text") {
    return requireString(body.text, "content.body.text", true);
  }
  if (body.type === "rich_text" && Array.isArray(body.blocks)) {
    return body.blocks
      .filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" &&
          block !== null &&
          !Array.isArray(block) &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  throw new TypeError("Unsupported publication body");
}

function parseTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    throw new TypeError("content.tags must be an array of strings");
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  const result = requireString(value, name);
  if (result.length > maxLength) {
    throw new TypeError(`${name} must not exceed ${maxLength} characters`);
  }
  return result;
}
