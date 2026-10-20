import type { PlatformContentCapability } from "@nedia-matrix/platform-sdk";

import { douyinContentCapability } from "./data-reader.js";
import { douyinPlatformModule as baseDouyinPlatformModule } from "./platform.js";
import { douyinRequestedContentCapability } from "./requested-content-reader.js";

// 功能验证期间在这里手动切换抖音作品读取方式。
export type DouyinContentReaderMode = "observed" | "requested";
export const DOUYIN_CONTENT_READER_MODE: DouyinContentReaderMode = "requested";

const contentReaders: Record<
  DouyinContentReaderMode,
  PlatformContentCapability
> = {
  observed: douyinContentCapability,
  requested: douyinRequestedContentCapability,
};

export const douyinPlatformModule = {
  ...baseDouyinPlatformModule,
  content: contentReaders[DOUYIN_CONTENT_READER_MODE],
};

export { douyinRequestedContentCapability } from "./requested-content-reader.js";
export { buildDouyinContentUrl } from "./content-url.js";
export {
  parseDouyinAccountProfile,
  parseDouyinContentPage,
} from "./data-reader.js";
