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

import { buildKuaishouContentUrl } from "./content-url.js";

const PROFILE_PAGE_URL = "https://cp.kuaishou.com/profile";
const PROFILE_API_URL =
  "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo";
const PROFILE_SUPPLEMENT_API_URL =
  "https://cp.kuaishou.com/rest/cp/creator/pc/home/infoV2";
const CONTENT_PAGE_URL = "https://cp.kuaishou.com/article/manage/video";
const CONTENT_API_URL =
  "https://cp.kuaishou.com/rest/cp/works/v2/video/pc/photo/list";
const CONTENT_SCROLL_SELECTOR = "#main-container";
const MAX_CONTENT_PAGES = 500;
const NEXT_PAGE_TIMEOUT_MS = 10_000;

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

function unixMilliseconds(value: unknown): string | undefined {
  const milliseconds = count(value);
  if (milliseconds === undefined) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseKuaishouAccountProfileResponse(body: unknown): {
  externalAccountId?: string;
  profile: PlatformAccountProfileData;
} {
  const info = record(record(record(body)?.data)?.coreUserInfo);
  if (!info) throw new Error("快手账号资料响应缺少 coreUserInfo");
  return {
    ...(text(info.userId) ? { externalAccountId: text(info.userId) } : {}),
    profile: {
      ...(text(info.userText) ? { description: text(info.userText) } : {}),
      ...(count(info.fansNum) !== undefined
        ? { followerCount: count(info.fansNum) }
        : {}),
      ...(count(info.followNum) !== undefined
        ? { followingCount: count(info.followNum) }
        : {}),
      ...(count(info.photoNum) !== undefined
        ? { contentCount: count(info.photoNum) }
        : {}),
    },
  };
}

export function parseKuaishouAccountProfile(
  body: unknown,
): PlatformAccountProfileData {
  return parseKuaishouAccountProfileResponse(body).profile;
}

export function parseKuaishouAccountSupplement(
  body: unknown,
  expectedExternalAccountId: string,
): PlatformAccountProfileData {
  const root = record(body);
  if (!root || root.result !== 1) {
    throw new Error("快手账号资料补全响应失败");
  }
  const data = record(root.data);
  if (!data) throw new Error("快手账号资料补全响应缺少 data");
  if (text(data.userId) !== expectedExternalAccountId) {
    throw new Error("快手账号资料补全响应与当前账号不一致");
  }
  return {
    ...(count(data.likeCnt) !== undefined
      ? { likeCount: count(data.likeCnt) }
      : {}),
  };
}

function parseContent(
  value: unknown,
  expectedExternalAccountId: string,
): PlatformContentData | null {
  const item = record(value);
  if (!item) return null;
  const externalContentId = text(item.workId);
  if (!externalContentId) return null;
  const ownerId = text(item.userId);
  if (ownerId && ownerId !== expectedExternalAccountId) {
    throw new Error("快手作品列表账号与当前登录账号不一致");
  }
  const duration = count(item.durationSecond);
  const contentUrl = buildKuaishouContentUrl(externalContentId);
  return {
    externalContentId,
    ...(contentUrl ? { contentUrl } : {}),
    contentType: duration === 0 ? "image_text" : "video",
    ...(text(item.title) ? { title: text(item.title) } : {}),
    ...(text(item.publishCoverUrl)
      ? { coverUrl: text(item.publishCoverUrl) }
      : {}),
    ...(unixMilliseconds(item.uploadTime)
      ? { publishedAt: unixMilliseconds(item.uploadTime) }
      : {}),
    ...(item.publishStatus !== undefined
      ? { platformStatus: String(item.publishStatus) }
      : {}),
    metrics: {
      ...(count(item.playCount) !== undefined
        ? { viewCount: count(item.playCount) }
        : {}),
      ...(count(item.likeCount) !== undefined
        ? { likeCount: count(item.likeCount) }
        : {}),
      ...(count(item.commentCount) !== undefined
        ? { commentCount: count(item.commentCount) }
        : {}),
    },
  };
}

export function parseKuaishouContentPage(
  body: unknown,
  expectedExternalAccountId: string,
): {
  items: PlatformContentData[];
  nextCursor?: string;
  total?: number;
} {
  const root = record(body);
  if (!root || root.result !== 1) throw new Error("快手作品列表响应失败");
  const data = record(root.data);
  const source = Array.isArray(data?.list) ? data.list : [];
  return {
    items: source.flatMap((value) => {
      const parsed = parseContent(value, expectedExternalAccountId);
      return parsed ? [parsed] : [];
    }),
    ...(text(data?.nextCursor) ? { nextCursor: text(data?.nextCursor) } : {}),
    ...(count(data?.total) !== undefined ? { total: count(data?.total) } : {}),
  };
}

export const kuaishouAccountProfileCapability: PlatformAccountProfileCapability =
  {
    implementationStatus: "reference-derived",
    async read(client) {
      const [response, supplementResponse] = await navigateForJsonResponses(
        client,
        PROFILE_PAGE_URL,
        [
          { method: "POST", url: PROFILE_API_URL, timeoutMs: 10_000 },
          { method: "POST", url: PROFILE_SUPPLEMENT_API_URL, timeoutMs: 3_000 },
        ],
      );
      if (!response?.ok || response.body === null) {
        throw new Error("快手账号资料响应未出现");
      }
      const primary = parseKuaishouAccountProfileResponse(response.body);
      if (
        !primary.externalAccountId ||
        !supplementResponse?.ok ||
        supplementResponse.body === null
      ) {
        return primary.profile;
      }
      try {
        return {
          ...primary.profile,
          ...parseKuaishouAccountSupplement(
            supplementResponse.body,
            primary.externalAccountId,
          ),
        };
      } catch {
        return primary.profile;
      }
    },
  };

export const kuaishouContentCapability: PlatformContentCapability = {
  implementationStatus: "reference-derived",
  async read(
    client,
    expectedExternalAccountId,
  ): Promise<PlatformContentReadResult> {
    const [response] = await navigateForJsonResponses(
      client,
      CONTENT_PAGE_URL,
      [{ method: "POST", url: CONTENT_API_URL, timeoutMs: 10_000 }],
    );
    if (!response?.ok || response.body === null) {
      throw new Error("快手作品列表响应未出现");
    }
    const items = new Map<string, PlatformContentData>();
    let pagesRead = 0;
    let remoteTotal: number | undefined;
    let nextCursor: string | undefined;

    const addPage = (body: unknown): number => {
      const parsed = parseKuaishouContentPage(body, expectedExternalAccountId);
      const sizeBefore = items.size;
      for (const item of parsed.items) items.set(item.externalContentId, item);
      remoteTotal = parsed.total ?? remoteTotal;
      nextCursor = parsed.nextCursor;
      pagesRead += 1;
      return items.size - sizeBefore;
    };

    addPage(response.body);
    const initialResult = resultAtPaginationBoundary(
      items,
      pagesRead,
      remoteTotal,
      nextCursor,
    );
    if (initialResult) return initialResult;

    while (pagesRead < MAX_CONTENT_PAGES) {
      const requestedAfterCursor = nextCursor;
      let nextPage: Awaited<ReturnType<typeof scrollForNextJsonResponse>>;
      try {
        nextPage = await scrollForNextJsonResponse(client, {
          selector: CONTENT_SCROLL_SELECTOR,
          response: {
            method: "POST",
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
          `快手作品第 ${pagesRead + 1} 页同步停止（${error.userMessage}）`,
        );
      }
      const { scroll, response: nextResponse } = nextPage;
      if (!scroll.found) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "快手作品列表滚动容器未出现",
        );
      }

      if (!nextResponse?.ok || nextResponse.body === null) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "滚动快手作品列表后未观察到下一页响应",
        );
      }

      const added = addPage(nextResponse.body);
      const boundaryResult = resultAtPaginationBoundary(
        items,
        pagesRead,
        remoteTotal,
        nextCursor,
      );
      if (boundaryResult) return boundaryResult;
      if (added === 0) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "快手作品分页未产生新作品，已停止同步",
        );
      }
      if (nextCursor === requestedAfterCursor) {
        return partialContentResult(
          items,
          pagesRead,
          remoteTotal,
          "快手作品分页游标未推进，已停止同步",
        );
      }
    }

    return partialContentResult(
      items,
      pagesRead,
      remoteTotal,
      `快手作品分页达到 ${MAX_CONTENT_PAGES} 页安全上限`,
    );
  },
};

function resultAtPaginationBoundary(
  items: Map<string, PlatformContentData>,
  pagesRead: number,
  remoteTotal: number | undefined,
  nextCursor: string | undefined,
): PlatformContentReadResult | undefined {
  if (remoteTotal !== undefined && items.size >= remoteTotal) {
    return completedContentResult(items, pagesRead, remoteTotal);
  }
  if (nextCursor) return undefined;
  if (remoteTotal !== undefined && items.size < remoteTotal) {
    return partialContentResult(
      items,
      pagesRead,
      remoteTotal,
      "快手作品分页已无下一页游标，但已读取数量仍少于平台总数",
    );
  }
  return completedContentResult(items, pagesRead, remoteTotal);
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
