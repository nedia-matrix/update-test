export function buildKuaishouContentUrl(contentId: string): string | null {
  const normalizedContentId = contentId.trim();
  return normalizedContentId
    ? `https://www.kuaishou.com/short-video/${normalizedContentId}`
    : null;
}
