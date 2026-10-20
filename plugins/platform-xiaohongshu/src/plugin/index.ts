import type { PlatformPluginEntry } from "@nedia-matrix/platform-sdk";
import { xiaohongshuPlatformModule } from "../platform.js";
import { createXhsSignedDataClient } from "./signed-data-client.js";
import { openXhsPublisher } from "./signed-publisher.js";
export const plugin: PlatformPluginEntry = {
  module: xiaohongshuPlatformModule,
  execution: {
    openDataClient({ base, account, host, settings }) {
      if (settings.submissionMode !== "automatic")
        throw new Error("Unsupported XHS settings");
      if (account.identityScheme !== "xiaohongshu.red_num")
        throw new Error("XHS data account binding is invalid");
      return createXhsSignedDataClient(base, host, () =>
        host.assertOwnership(),
      );
    },
    openPublisher: openXhsPublisher,
  },
};
