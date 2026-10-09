import { afterEach, describe, expect, it, vi } from "vitest";

import {
  publicationComposeHref,
  publicationRecordsHref,
  onPublishingRouteChange,
  readPublishingRoute,
} from "../src/renderer/src/publishing-route.js";

describe("publishing navigation", () => {
  it("opens records by default and only opens the editor explicitly", () => {
    expect(readPublishingRoute("#/publish").tab).toBe("records");
    expect(readPublishingRoute(publicationComposeHref).tab).toBe("compose");
    expect(readPublishingRoute("#/publish?tab=unknown").tab).toBe("records");
  });

  it("keeps old record links, filters and focused publications working", () => {
    const route = readPublishingRoute(
      "#/publications?group=action_required&platformId=douyin&accountId=a1&keyword=hello&publicationId=p1",
    );
    expect(route).toEqual({
      tab: "records",
      publicationId: "p1",
      filters: {
        group: "action_required",
        platformId: "douyin",
        accountId: "a1",
        keyword: "hello",
      },
    });
    expect(
      readPublishingRoute(
        publicationRecordsHref(route.filters, route.publicationId),
      ),
    ).toEqual(route);
  });

  it("prioritizes a publication detail link over the compose tab", () => {
    expect(
      readPublishingRoute("#/publish?tab=compose&publicationId=p1").tab,
    ).toBe("records");
    expect(readPublishingRoute("#/publications?tab=compose").tab).toBe(
      "records",
    );
  });

  it("ignores invalid status groups and empty publication IDs", () => {
    expect(
      readPublishingRoute("#/publish?group=unknown&publicationId="),
    ).toMatchObject({
      publicationId: undefined,
      filters: { group: "" },
    });
  });

  it("encodes record links without losing non-ASCII or reserved characters", () => {
    const filters = {
      platformId: "",
      accountId: "a&1",
      group: "" as const,
      keyword: "  生活 & #记录  ",
    };
    const href = publicationRecordsHref(filters, "p?1");
    expect(readPublishingRoute(href)).toMatchObject({
      publicationId: "p?1",
      filters: { ...filters, keyword: "生活 & #记录" },
    });
    expect(publicationRecordsHref()).toBe("#/publish");
  });
});

describe("publishing route subscription", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(hash: string) {
    const events = new EventTarget();
    const location = { hash };
    vi.stubGlobal("location", location);
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal(
      "removeEventListener",
      events.removeEventListener.bind(events),
    );
    return {
      location,
      events,
      navigate(nextHash: string) {
        location.hash = nextHash;
        events.dispatchEvent(new Event("hashchange"));
      },
    };
  }

  it.each(["#/settings", "#/accounts", "#/publish-other", ""])(
    "leaves %s intact when publishing subscribes before the app after reload",
    (destination) => {
      const { location, events, navigate } = setup("#/publish");
      const publishingListener = vi.fn((route) => {
        // The records page normalizes its URL without emitting hashchange.
        location.hash = publicationRecordsHref(
          route.filters,
          route.publicationId,
        );
      });
      const stop = onPublishingRouteChange(publishingListener);
      publishingListener.mockClear();
      const appListener = vi.fn(() => location.hash);
      events.addEventListener("hashchange", appListener);

      navigate(destination);

      expect(publishingListener).not.toHaveBeenCalled();
      expect(appListener).toHaveReturnedWith(destination);
      expect(location.hash).toBe(destination);
      stop();
    },
  );

  it("handles publishing tabs, filters and legacy routes, then unsubscribes", () => {
    const { navigate } = setup("#/publish?group=action_required");
    const listener = vi.fn();
    const stop = onPublishingRouteChange(listener);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tab: "records",
        filters: expect.objectContaining({ group: "action_required" }),
      }),
    );

    navigate(publicationComposeHref);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "compose" }),
    );
    navigate("#/publications?publicationId=p1");
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "records", publicationId: "p1" }),
    );

    stop();
    navigate("#/publish");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not normalize another page during subscription", () => {
    setup("#/settings");
    const listener = vi.fn();
    const stop = onPublishingRouteChange(listener);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
