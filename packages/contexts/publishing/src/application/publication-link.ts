import {
  isAllowedPlatformUrl,
  type PlatformModule,
} from "@nedia-matrix/platform-sdk";

import type { PublicationSnapshot } from "./index.js";

export function requireSafePublicationUrl(
  record: PublicationSnapshot,
  platform: PlatformModule | undefined,
): string {
  if (!platform) throw new TypeError("平台插件不可用，无法打开作品链接");
  const url = record.publication.platformContentUrl;
  if (!url) throw new TypeError("Publication does not have a platform URL");
  if (!isAllowedPlatformUrl(platform.browser, url)) {
    throw new TypeError("Publication URL is outside the platform boundary");
  }
  return url;
}
