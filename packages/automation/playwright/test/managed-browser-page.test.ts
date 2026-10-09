import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createManagedBrowserPage } from "../src/managed-browser-page.js";

function fixture() {
  const events = new EventEmitter();
  let closed = false;
  const context = {};
  const page = Object.assign(events, {
    context: () => context,
    goto: vi.fn(async (): Promise<void> => undefined),
    url: () => "https://example.test/",
    isClosed: () => closed,
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      closed = true;
      events.emit("close");
    }),
  });
  const browser = { context: { newPage: async () => page }, headless: false };
  const options = {
    profileDirectory: "/profiles/account",
    profileId: "account",
    evidenceDirectory: "/evidence",
    browser: {
      startUrl: "https://example.test/",
      allowedHostSuffixes: ["example.test"],
    },
    sessionDetection: { probes: [] },
  };
  return {
    page,
    create: () => createManagedBrowserPage(browser as never, options, "sync"),
  };
}

describe("managed page ownership", () => {
  it("revokes even a previously captured control method after handoff while retaining observation", async () => {
    const f = fixture();
    const page = await f.create();
    const navigate = page.driver.navigate;
    await page.handoff();
    await expect(navigate("https://example.test/other")).rejects.toThrow(
      "控制权",
    );
    expect(await page.driver.currentUrl()).toBe("https://example.test/");
    await page.release();
    expect(f.page.close).not.toHaveBeenCalled();
    expect(page.owner).toBe("HUMAN");
  });
  it("revokes new commands before waiting for an in-flight command to finish", async () => {
    const f = fixture();
    let finish = () => {};
    f.page.goto.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const page = await f.create();
    const navigate = page.driver.navigate("https://example.test/a");
    await Promise.resolve();
    const handoff = page.handoff();
    expect(page.owner).toBe("AUTOMATION");
    await expect(
      page.driver.navigate("https://example.test/b"),
    ).rejects.toThrow("控制权");
    finish();
    await expect(navigate).rejects.toThrow("控制权");
    await handoff;
    expect(page.owner).toBe("HUMAN");
    expect(f.page.goto).toHaveBeenCalledOnce();
  });
  it("closes automation pages once and allows explicit closure of human pages", async () => {
    const f = fixture();
    const page = await f.create();
    await Promise.all([page.release(), page.release()]);
    expect(f.page.close).toHaveBeenCalledOnce();
    const g = fixture();
    const human = await g.create();
    await human.handoff();
    await expect(human.close()).rejects.toThrow("用户关闭");
    await human.closeByUser();
    expect(g.page.close).toHaveBeenCalledOnce();
  });
});
