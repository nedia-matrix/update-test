import {
  PlatformDataOperationError,
  scrollForNextJsonResponse,
  navigateForJsonResponses,
} from "@nedia-matrix/platform-sdk";
import type {
  PlatformAccountProfileCapability,
  PlatformAccountProfileData,
  PlatformContentCapability,
  PlatformContentData,
  PlatformContentReadResult,
} from "@nedia-matrix/platform-sdk";

import { buildXiaohongshuContentUrl } from "./content-url.js";

const PROFILE_PAGE_URL = "https://creator.xiaohongshu.com/new/home";
const PROFILE_API_URL =
  "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info";
const CONTENT_PAGE_URL = "https://creator.xiaohongshu.com/new/note-manager";
const CONTENT_API_URL =
  "https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted";
const CONTENT_SCROLL_SELECTOR = ".content";
const MAX_CONTENT_PAGES = 500;
const NEXT_PAGE_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function secureUrl(value: unknown): string | undefined {
  return text(value)?.replace(/^http:\/\//i, "https://");
}

function count(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function unixSeconds(value: unknown): string | undefined {
  const seconds = count(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseXiaohongshuAccountProfile(
  body: unknown,
): PlatformAccountProfileData {
  const data = record(record(body)?.data);
  if (!data) throw new Error("小红书账号资料响应缺少 data");
  return {
    ...(text(data.personal_desc)
      ? { description: text(data.personal_desc) }
      : {}),
    ...(count(data.fans_count) !== undefined
      ? { followerCount: count(data.fans_count) }
      : {}),
    ...(count(data.follow_count) !== undefined
      ? { followingCount: count(data.follow_count) }
      : {}),
    ...(count(data.notes_count) !== undefined
      ? { contentCount: count(data.notes_count) }
      : {}),
    ...(count(data.faved_count) !== undefined
      ? { likeCount: count(data.faved_count) }
      : {}),
  };
}

function parseContent(value: unknown): PlatformContentData | null {
  const item = record(value);
  if (!item) return null;
  const externalContentId = text(item.id);
  if (!externalContentId) return null;
  const images = Array.isArray(item.images_list) ? item.images_list : [];
  const coverUrl = secureUrl(record(images[0])?.url);
  const type = text(item.type);
  const contentUrl = buildXiaohongshuContentUrl(externalContentId);
  return {
    externalContentId,
    ...(contentUrl ? { contentUrl } : {}),
    contentType:
      type === "video" ? "video" : type === "normal" ? "image_text" : "unknown",
    ...(text(item.display_title) ? { title: text(item.display_title) } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(unixSeconds(item.visible_time)
      ? { publishedAt: unixSeconds(item.visible_time) }
      : {}),
    ...(item.tab_status !== undefined
      ? { platformStatus: String(item.tab_status) }
      : item.permission_code !== undefined
        ? { platformStatus: String(item.permission_code) }
        : {}),
    metrics: {
      ...(count(item.view_count) !== undefined
        ? { viewCount: count(item.view_count) }
        : {}),
      ...(count(item.likes) !== undefined
        ? { likeCount: count(item.likes) }
        : {}),
      ...(count(item.comments_count) !== undefined
        ? { commentCount: count(item.comments_count) }
        : {}),
      ...(count(item.shared_count) !== undefined
        ? { shareCount: count(item.shared_count) }
        : {}),
      ...(count(item.collected_count) !== undefined
        ? { collectCount: count(item.collected_count) }
        : {}),
    },
  };
}

export function parseXiaohongshuContentPage(body: unknown): {
  items: PlatformContentData[];
  total?: number;
} {
  const root = record(body);
  if (!root || root.success !== true || root.code !== 0) {
    throw new Error("小红书作品列表响应失败");
  }
  const data = record(root.data);
  const source = Array.isArray(data?.notes) ? data.notes : [];
  const tags = Array.isArray(data?.tags) ? data.tags : [];
  const allNotes = tags
    .map(record)
    .find((tag) => tag?.id === "special.note_time_desc");
  return {
    items: source.flatMap((value) => {
      const parsed = parseContent(value);
      return parsed ? [parsed] : [];
    }),
    ...(count(allNotes?.notes_count) !== undefined
      ? { total: count(allNotes?.notes_count) }
      : {}),
  };
}

export const xiaohongshuAccountProfileCapability: PlatformAccountProfileCapability =
  {
    implementationStatus: "reference-derived",
    async read(client) {
      const [response] = await navigateForJsonResponses(
        client,
        PROFILE_PAGE_URL,
        [{ method: "GET", url: PROFILE_API_URL, timeoutMs: 10_000 }],
      );
      if (!response?.ok || response.body === null) {
        throw new Error("小红书账号资料响应未出现或请求失败");
      }
      return parseXiaohongshuAccountProfile(response.body);
    },
  };

export const xiaohongshuContentCapability: PlatformContentCapability = {
  implementationStatus: "reference-derived",
  async read(client): Promise<PlatformContentReadResult> {
    const [response] = await navigateForJsonResponses(
      client,
      CONTENT_PAGE_URL,
      [{ method: "GET", url: CONTENT_API_URL, timeoutMs: 10_000 }],
    );
    if (!response?.ok || response.body === null) {
      throw new Error("小红书作品列表首屏响应未出现");
    }
    const items = new Map<string, PlatformContentData>();
    let pagesRead = 0;
    let remoteTotal: number | undefined;

    const addPage = (body: unknown): number => {
      const parsed = parseXiaohongshuContentPage(body);
      const sizeBefore = items.size;
      for (const item of parsed.items) items.set(item.externalContentId, item);
      remoteTotal = parsed.total ?? remoteTotal;
      pagesRead += 1;
      return items.size - sizeBefore;
    };

    addPage(response.body);
    if (items.size === 0 || reachedRemoteTotal(items, remoteTotal)) {
      return completedContentResult(items, pagesRead, remoteTotal);
    }

    while (pagesRead < MAX_CONTENT_PAGES) {
      let nextPage: Awaited<ReturnType<typeof scrollForNextJsonResponse>>;
      try {
        nextPage = await scrollForNextJsonResponse(client, {
          selector: CONTENT_SCROLL_SELECTOR,
          response: {
            method: "GET",
            url: CONTENT_API_URL,
            timeoutMs: NEXT_PAGE_TIMEOUT_MS,
            replayObserved: false,
          },
        });
      } catch (error) {
        if (!(error instanceof PlatformDataOperationError)) throw error;
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          `小红书作品第 ${pagesRead + 1} 页同步停止（${error.userMessage}）`,
        );
      }
      const { scroll, response: nextResponse } = nextPage;
      if (!scroll.found) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "小红书作品列表滚动容器未出现",
        );
      }

      if (!nextResponse?.ok || nextResponse.body === null) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "滚动小红书作品列表后未观察到下一页响应",
        );
      }

      const added = addPage(nextResponse.body);
      if (reachedRemoteTotal(items, remoteTotal)) {
        return completedContentResult(items, pagesRead, remoteTotal);
      }
      if (added === 0) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "小红书作品分页未产生新作品，已停止同步",
        );
      }
    }

    return partialContentResult(
      items,
      pagesRead,
      remoteTotal,
      `小红书作品分页达到 ${MAX_CONTENT_PAGES} 页安全上限`,
    );
  },
};

function reachedRemoteTotal(
  items: Map<string, PlatformContentData>,
  remoteTotal: number | undefined,
): boolean {
  return remoteTotal !== undefined && items.size >= remoteTotal;
}

function completedContentResult(
  items: Map<string, PlatformContentData>,
  pagesRead: number,
  remoteTotal: number | undefined,
): PlatformContentReadResult {
  return {
    items: [...items.values()],
    complete: true,
    pagesRead,
    ...(remoteTotal === undefined ? {} : { remoteTotal }),
  };
}

function partialContentResult(
  items: Map<string, PlatformContentData>,
  pagesRead: number,
  remoteTotal: number | undefined,
  diagnostic: string,
): PlatformContentReadResult {
  return {
    items: [...items.values()],
    complete: false,
    pagesRead,
    ...(remoteTotal === undefined ? {} : { remoteTotal }),
    diagnostics: [diagnostic],
  };
}
