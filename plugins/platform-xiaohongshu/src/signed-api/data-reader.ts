import { isPlatformDataOperationError } from "@nedia-matrix/platform-sdk";
import { buildXiaohongshuContentUrl } from "../shared/content-url.js";
import { xhsVideoPermitEndpoint } from "./video-preparation.js";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";
import type {
  PlatformAccountProfileCapability,
  PlatformAccountProfileData,
  PlatformContentCapability,
  PlatformContentData,
  PlatformContentReadResult,
  PlatformDataClient,
} from "@nedia-matrix/platform-sdk";

export const xhsIdentityEndpoint =
  "https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info";
const contentEndpoint =
  "https://creator.xiaohongshu.com/api/galaxy/v2/creator/note/user/posted";
export function xhsContentEndpoint(page: number): string {
  if (!Number.isSafeInteger(page) || page < 0 || page >= 500)
    throw new Error("Invalid XHS content page");
  return `${contentEndpoint}?tab=0&page=${page}`;
}

/** Exact endpoint and query allowlist for the shared private transport. */
export function isXhsSignedEndpoint(url: string): boolean {
  return (
    url === xhsIdentityEndpoint ||
    url === xhsVideoPermitEndpoint ||
    url === "https://edith.xiaohongshu.com/web_api/sns/v2/note" ||
    url ===
      "https://creator.xiaohongshu.com/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web" ||
    (/^https:\/\/creator\.xiaohongshu\.com\/api\/galaxy\/v2\/creator\/note\/user\/posted\?tab=0&page=(0|[1-9][0-9]{0,2})$/.test(
      url,
    ) &&
      Number(new URL(url).searchParams.get("page")) < 500)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function count(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && /^\d+$/.test(value))
  )
    return;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function data(body: unknown): Record<string, unknown> {
  const root = record(body);
  const result = record(root?.data);
  if (!root || root.code !== 0 || root.success === false || !result)
    throw new Error("小红书接口响应无效或登录已失效");
  return result;
}
export function verifyXhsIdentity(body: unknown, expected: string): void {
  const identity = data(body);
  if (
    !expected ||
    String(identity.red_num) !== expected ||
    !text(identity.name)
  )
    throw new Error("小红书接口账号与当前账号不一致，请重新登录");
}
export function parseXhsAccountProfile(
  body: unknown,
): PlatformAccountProfileData {
  const profile = data(body);
  return {
    description: text(profile.personal_desc),
    followerCount: count(profile.fans_count),
    followingCount: count(profile.follow_count),
    contentCount: count(profile.notes_count),
    likeCount: count(profile.faved_count),
  };
}
function cover(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    url.protocol = "https:";
    return url.toString();
  } catch {
    return;
  }
}
export function parseXhsContentPage(body: unknown): {
  items: PlatformContentData[];
  total?: number;
} {
  const page = data(body);
  if (!Array.isArray(page.notes))
    throw new Error("小红书作品响应缺少 notes 列表");
  const items = page.notes.map((value): PlatformContentData => {
    const item = record(value);
    const id = text(item?.id);
    if (!item || !id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new Error("小红书作品响应缺少有效作品 ID");
    const seconds = count(item.visible_time);
    const time = seconds === undefined ? undefined : new Date(seconds * 1000);
    return {
      externalContentId: id,
      contentUrl: buildXiaohongshuContentUrl(id) ?? undefined,
      contentType:
        item.type === "normal"
          ? "image_text"
          : item.type === "video"
            ? "video"
            : "unknown",
      title: text(item.display_title),
      coverUrl: cover(
        record(
          Array.isArray(item.images_list) ? item.images_list[0] : undefined,
        )?.url,
      ),
      publishedAt:
        time && Number.isFinite(time.getTime())
          ? time.toISOString()
          : undefined,
      platformStatus:
        typeof item.tab_status === "number"
          ? String(item.tab_status)
          : typeof item.permission_code === "number"
            ? String(item.permission_code)
            : undefined,
      metrics: Object.fromEntries(
        Object.entries({
          viewCount: count(item.view_count),
          likeCount: count(item.likes),
          commentCount: count(item.comments_count),
          shareCount: count(item.shared_count),
          collectCount: count(item.collected_count),
        }).filter(([, value]) => value !== undefined),
      ),
    };
  });
  const tag = Array.isArray(page.tags)
    ? page.tags.map(record).find((t) => t?.id === "special.note_time_desc")
    : undefined;
  return { items, total: count(tag?.notes_count) };
}
async function request(
  client: PlatformDataClient,
  url: string,
): Promise<unknown> {
  const response = await client.requestJson({
    method: "GET",
    url,
    timeoutMs: 15_000,
  });
  if (response.status === 429)
    throw new PlatformDataOperationError("rate_limited", "平台请求受限");
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error("小红书登录已失效或请求被拒绝，请打开账号浏览器检查");
    throw new PlatformDataOperationError(
      "request_failed",
      "小红书接口请求失败",
    );
  }
  return response.body;
}
export const xhsAccountProfileCapability: PlatformAccountProfileCapability = {
  implementationStatus: "live-tested",
  async read(client) {
    return parseXhsAccountProfile(await request(client, xhsIdentityEndpoint));
  },
};
export const xhsContentCapability: PlatformContentCapability = {
  implementationStatus: "live-tested",
  async read(
    client,
    expectedExternalAccountId,
    options?: Parameters<PlatformContentCapability["read"]>[2],
  ): Promise<PlatformContentReadResult> {
    verifyXhsIdentity(
      await request(client, xhsIdentityEndpoint),
      expectedExternalAccountId,
    );
    const items = new Map<string, PlatformContentData>();
    let pagesRead = 0;
    let remoteTotal: number | undefined;
    const finish = (
      complete: boolean,
      diagnostic?: string,
    ): PlatformContentReadResult => ({
      items: [...items.values()],
      complete,
      pagesRead,
      ...(remoteTotal === undefined ? {} : { remoteTotal }),
      ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    });
    for (let page = 0; page < 500; page++) {
      let body: unknown;
      try {
        body = await request(client, xhsContentEndpoint(page));
      } catch (error) {
        if (pagesRead && isPlatformDataOperationError(error))
          return finish(
            false,
            `作品第 ${page + 1} 页同步停止（${error.userMessage}）`,
          );
        throw error;
      }
      const parsed = parseXhsContentPage(body);
      pagesRead++;
      remoteTotal = parsed.total ?? remoteTotal;
      const previousSize = items.size;
      for (const item of parsed.items) items.set(item.externalContentId, item);
      await options?.onPage?.({
        items: parsed.items,
        pagesRead,
        ...(remoteTotal === undefined ? {} : { remoteTotal }),
      });
      if (remoteTotal !== undefined && items.size >= remoteTotal)
        return finish(true);
      if (!parsed.items.length)
        return remoteTotal === undefined
          ? finish(true)
          : finish(false, "作品列表提前结束，未达到远端总数");
      if (previousSize === items.size)
        return finish(false, "作品分页未产生新作品，已停止同步");
    }
    return finish(false, "作品分页达到 500 页安全上限");
  },
};
