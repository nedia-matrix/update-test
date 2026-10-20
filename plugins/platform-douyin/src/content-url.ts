import type { PlatformContentData } from "@nedia-matrix/platform-sdk";

export function buildDouyinContentUrl(
  contentId: string,
  contentType: PlatformContentData["contentType"],
): string | null {
  const normalizedContentId = contentId.trim();
  if (!normalizedContentId) return null;
  if (contentType === "video") {
    return `https://www.douyin.com/video/${normalizedContentId}`;
  }
  if (contentType === "image_text") {
    return `https://www.douyin.com/note/${normalizedContentId}`;
  }
  return null;
}
