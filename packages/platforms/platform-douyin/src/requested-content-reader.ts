import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";
import type {
  PlatformContentCapability,
  PlatformContentData,
  PlatformContentReadResult,
  PlatformJsonResponse,
} from "@nedia-matrix/platform-sdk";

import { parseDouyinContentPage } from "./data-reader.js";

const CONTENT_PAGE_URL =
  "https://creator.douyin.com/creator-micro/content/manage";
const CONTENT_API_URL =
  "https://creator.douyin.com/janus/douyin/creator/pc/work_list";
const PAGE_SIZE = 20;
const MAX_PAGES = 500;

function contentPageUrl(cursor: string): string {
  return `${CONTENT_API_URL}?status=0&count=${PAGE_SIZE}&max_cursor=${encodeURIComponent(cursor)}&scene=star_atlas&device_platform=android&aid=1128`;
}

function partialResult(
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

export const douyinRequestedContentCapability: PlatformContentCapability = {
  implementationStatus: "reference-derived",
  async read(
    client,
    expectedExternalAccountId,
  ): Promise<PlatformContentReadResult> {
    await client.navigate(CONTENT_PAGE_URL);

    const items = new Map<string, PlatformContentData>();
    const seenCursors = new Set<string>();
    let cursor = "0";
    let pagesRead = 0;
    let remoteTotal: number | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (seenCursors.has(cursor)) {
        return partialResult(
          items,
          pagesRead,
          remoteTotal,
          "抖音作品游标未前进，已停止同步",
        );
      }
      seenCursors.add(cursor);

      let response: PlatformJsonResponse;
      try {
        response = await client.requestJson({
          method: "GET",
          url: contentPageUrl(cursor),
        });
      } catch (error) {
        if (pagesRead === 0 || !(error instanceof PlatformDataOperationError))
          throw error;
        return partialResult(
          items,
          pagesRead,
          remoteTotal,
          `抖音作品第 ${pagesRead + 1} 页同步停止（${error.userMessage}）`,
        );
      }
      if (!response.ok || response.body === null) {
        if (pagesRead === 0) {
          throw new Error(`抖音作品列表请求失败（HTTP ${response.status}）`);
        }
        return partialResult(
          items,
          pagesRead,
          remoteTotal,
          `抖音作品第 ${pagesRead + 1} 页请求失败（HTTP ${response.status}）`,
        );
      }

      const parsed = parseDouyinContentPage(
        response.body,
        expectedExternalAccountId,
      );
      pagesRead += 1;
      for (const item of parsed.items) {
        items.set(item.externalContentId, item);
      }
      remoteTotal = parsed.total ?? remoteTotal;

      if (
        !parsed.hasMore ||
        (remoteTotal !== undefined && items.size >= remoteTotal)
      ) {
        return {
          items: [...items.values()],
          complete: true,
          pagesRead,
          ...(remoteTotal === undefined ? {} : { remoteTotal }),
        };
      }
      if (!parsed.nextCursor) {
        return partialResult(
          items,
          pagesRead,
          remoteTotal,
          "抖音响应声明仍有下一页，但缺少 max_cursor",
        );
      }
      cursor = parsed.nextCursor;
    }

    return partialResult(
      items,
      pagesRead,
      remoteTotal,
      `抖音作品分页超过 ${MAX_PAGES} 页安全上限`,
    );
  },
};
