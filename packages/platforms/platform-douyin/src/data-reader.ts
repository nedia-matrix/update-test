import { navigateForJsonResponses } from "@nedia-matrix/platform-sdk";
import type {
  PlatformAccountProfileCapability,
  PlatformAccountProfileData,
  PlatformContentCapability,
  PlatformContentData,
  PlatformContentReadResult,
} from "@nedia-matrix/platform-sdk";

import { buildDouyinContentUrl } from "./content-url.js";

const PROFILE_URL = "https://creator.douyin.com/web/api/media/user/info/";
const CONTENT_PAGE_URL =
  "https://creator.douyin.com/creator-micro/content/manage";
const CONTENT_API_URL =
  "https://creator.douyin.com/janus/douyin/creator/pc/work_list";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return undefined;
}

function count(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function firstUrl(value: unknown): string | undefined {
  const candidate = record(value)?.url_list;
  return Array.isArray(candidate) ? text(candidate[0]) : undefined;
}

function unixSeconds(value: unknown): string | undefined {
  const seconds = count(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseDouyinAccountProfile(
  body: unknown,
): PlatformAccountProfileData {
  const user = record(record(body)?.user);
  if (!user) throw new Error("抖音账号资料响应缺少 user");
  const description = text(user.signature);
  const followerCount = count(user.follower_count);
  const followingCount = count(user.following_count);
  const contentCount = count(user.aweme_count);
  const likeCount = count(user.total_favorited);
  return {
    description,
    followerCount,
    followingCount,
    contentCount,
    likeCount,
  };
}

function parseContent(
  value: unknown,
  expectedExternalAccountId: string,
): PlatformContentData | null {
  const item = record(value);
  if (!item) return null;
  const externalContentId = text(item.aweme_id);
  if (!externalContentId) return null;
  const author = record(item.author);
  const authorId = text(author?.short_id);
  if (authorId && authorId !== expectedExternalAccountId) {
    throw new Error("抖音作品列表账号与当前登录账号不一致");
  }
  const statistics = record(item.statistics);
  const images = Array.isArray(item.images) ? item.images : [];
  const cover =
    firstUrl(item.Cover) ??
    firstUrl(record(item.video)?.cover) ??
    firstUrl(images[0]);
  const description = text(item.desc);
  const title = text(record(item.next_info)?.item_title);
  const status = record(item.status);
  const contentType = images.length > 0 ? "image_text" : "video";
  const contentUrl = buildDouyinContentUrl(externalContentId, contentType);
  return {
    externalContentId,
    ...(contentUrl ? { contentUrl } : {}),
    contentType,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(cover ? { coverUrl: cover } : {}),
    ...(unixSeconds(item.create_time)
      ? { publishedAt: unixSeconds(item.create_time) }
      : {}),
    ...(item.status_value !== undefined
      ? { platformStatus: String(item.status_value) }
      : typeof status?.in_reviewing === "boolean"
        ? { platformStatus: status.in_reviewing ? "reviewing" : "published" }
        : {}),
    metrics: {
      ...(count(statistics?.play_count) !== undefined
        ? { viewCount: count(statistics?.play_count) }
        : {}),
      ...(count(statistics?.digg_count) !== undefined
        ? { likeCount: count(statistics?.digg_count) }
        : {}),
      ...(count(statistics?.comment_count) !== undefined
        ? { commentCount: count(statistics?.comment_count) }
        : {}),
      ...(count(statistics?.share_count) !== undefined
        ? { shareCount: count(statistics?.share_count) }
        : {}),
      ...(count(statistics?.collect_count) !== undefined
        ? { collectCount: count(statistics?.collect_count) }
        : {}),
    },
  };
}

export function parseDouyinContentPage(
  body: unknown,
  expectedExternalAccountId: string,
): {
  items: PlatformContentData[];
  hasMore: boolean;
  nextCursor?: string;
  total?: number;
} {
  const root = record(body);
  if (!root || (root.status_code !== undefined && root.status_code !== 0)) {
    throw new Error("抖音作品列表响应失败");
  }
  const source = Array.isArray(root.aweme_list) ? root.aweme_list : [];
  const items = source.flatMap((value) => {
    const parsed = parseContent(value, expectedExternalAccountId);
    return parsed ? [parsed] : [];
  });
  return {
    items,
    hasMore: root.has_more === true,
    ...(text(root.max_cursor) ? { nextCursor: text(root.max_cursor) } : {}),
    ...(count(root.total) !== undefined ? { total: count(root.total) } : {}),
  };
}

export const douyinAccountProfileCapability: PlatformAccountProfileCapability =
  {
    implementationStatus: "reference-derived",
    async read(client) {
      await client.navigate(CONTENT_PAGE_URL);
      const response = await client.requestJson({
        method: "GET",
        url: PROFILE_URL,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`抖音账号资料请求失败（HTTP ${response.status}）`);
      }
      return parseDouyinAccountProfile(response.body);
    },
  };

export const douyinContentCapability: PlatformContentCapability = {
  implementationStatus: "reference-derived",
  async read(
    client,
    expectedExternalAccountId,
  ): Promise<PlatformContentReadResult> {
    const [response] = await navigateForJsonResponses(
      client,
      CONTENT_PAGE_URL,
      [{ method: "GET", url: CONTENT_API_URL, timeoutMs: 10_000 }],
    );
    if (!response?.ok || response.body === null) {
      throw new Error("抖音作品列表首屏响应未出现");
    }
    const parsed = parseDouyinContentPage(
      response.body,
      expectedExternalAccountId,
    );
    const complete =
      !parsed.hasMore ||
      (parsed.total !== undefined && parsed.items.length >= parsed.total);
    return {
      items: parsed.items,
      complete,
      pagesRead: 1,
      ...(parsed.total === undefined ? {} : { remoteTotal: parsed.total }),
      ...(complete
        ? {}
        : {
            diagnostics: [
              "抖音首屏响应显示仍有下一页；翻页交互尚未验证，本次只保存已读取作品",
            ],
          }),
    };
  },
};
