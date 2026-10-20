export function buildXiaohongshuContentUrl(contentId: string): string | null {
  const normalizedContentId = contentId.trim();
  return normalizedContentId
    ? `https://www.xiaohongshu.com/explore/${normalizedContentId}`
    : null;
}
