import { join } from "node:path";
import type { PublicationApplicationDependencies } from "@nedia-matrix/publishing";
import type { PlaywrightBrowserSessionHost } from "../accounts/infrastructure/playwright-browser-session-host.js";
import { desktopPlugins } from "./desktop-plugins.js";
import { createPlatformExecutionHost } from "./execution-host.js";

export function createPluginPublisher(
  browser: PlaywrightBrowserSessionHost,
): NonNullable<PublicationApplicationDependencies["pluginPublishing"]> {
  return {
    async open({
      account,
      platform,
      publicationId,
      pageId,
      adapterId,
      settings,
    }) {
      const plugin = desktopPlugins().execution(platform.id);
      if (!plugin?.execution?.openPublisher)
        throw new Error("平台插件未提供此发布能力");
      const binding = {
        accountId: account.id,
        profileId: account.profileId,
        pageId,
        publicationId,
      };
      const context = browser.requirePublicationContext(binding);
      const authorized = new Set<string>();
      const session = await plugin.execution.openPublisher({
        account: {
          platformId: account.platformId,
          identityScheme: account.identityScheme,
          externalAccountId: account.externalAccountId,
        },
        adapterId,
        settings,
        host: createPlatformExecutionHost({
          context,
          assetDirectory: join(plugin.directory, "assets"),
          mediaReferences: authorized,
          assertOwnership: () => {
            browser.requirePublicationContext(binding);
          },
        }),
      });
      return {
        prepare(input, signal) {
          authorized.clear();
          for (const reference of input.mediaReferences)
            authorized.add(reference);
          return session.prepare(input, signal);
        },
        submit: (input) => session.submit(input),
        close: () => session.close(),
      };
    },
  };
}
