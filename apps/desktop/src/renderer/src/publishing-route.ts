import {
  publicationDisplayGroupOrder,
  type PublicationDisplayGroup,
} from "./shared.js";

export type PublishingTab = "records" | "compose";

export interface PublicationRecordFilters {
  platformId: string;
  accountId: string;
  group: PublicationDisplayGroup | "";
  keyword: string;
}

export function readPublishingRoute(hash: string): {
  tab: PublishingTab;
  publicationId?: string;
  filters: PublicationRecordFilters;
} {
  const [path, query] = hash.replace(/^#/, "").split("?", 2);
  const parameters = new URLSearchParams(query);
  const group = parameters.get("group") ?? "";
  const publicationId = parameters.get("publicationId") || undefined;
  return {
    tab:
      path !== "/publications" &&
      !publicationId &&
      parameters.get("tab") === "compose"
        ? "compose"
        : "records",
    publicationId,
    filters: {
      platformId: parameters.get("platformId") ?? "",
      accountId: parameters.get("accountId") ?? "",
      group: publicationDisplayGroupOrder.includes(
        group as PublicationDisplayGroup,
      )
        ? (group as PublicationDisplayGroup)
        : "",
      keyword: parameters.get("keyword") ?? "",
    },
  };
}

export function onPublishingRouteChange(
  listener: (route: ReturnType<typeof readPublishingRoute>) => void,
): () => void {
  const updateRoute = () => {
    const hash = globalThis.location.hash;
    const path = hash.replace(/^#/, "").split("?", 1)[0];
    // The publishing page can receive this event before App during a reload.
    // Leave other page routes untouched so App reads the intended destination.
    if (path !== "/publish" && path !== "/publications") return;
    listener(readPublishingRoute(hash));
  };
  globalThis.addEventListener("hashchange", updateRoute);
  updateRoute();
  return () => globalThis.removeEventListener("hashchange", updateRoute);
}

export function publicationRecordsHref(
  filters?: PublicationRecordFilters,
  publicationId?: string,
): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries({
    ...filters,
    keyword: filters?.keyword.trim(),
    publicationId,
  })) {
    if (value) parameters.set(key, value);
  }
  const query = parameters.toString();
  return "#/publish" + (query ? `?${query}` : "");
}

export const publicationComposeHref = "#/publish?tab=compose";
