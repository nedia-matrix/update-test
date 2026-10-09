import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createPlaywrightSessionProbeClient } from "../src/index.js";

function fixture() {
  const pageEvents = new EventEmitter();
  const page = Object.assign(pageEvents, {
    url: () => "https://cp.kuaishou.com/profile",
  });
  const browser = {
    startUrl: "https://cp.kuaishou.com/profile",
    allowedHostSuffixes: ["kuaishou.com"],
  } as never;
  const detection = {
    probes: [
      {
        source: {
          kind: "observed-response",
          method: "POST",
          url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo",
          timeoutMs: 100,
        },
        fields: { externalAccountId: ["id"], nickname: ["name"] },
      },
    ],
  } as never;
  const client = createPlaywrightSessionProbeClient(
    { request: {} } as never,
    page as never,
    browser,
    detection,
  );
  return { client, pageEvents };
}

function accountResponse(body: string) {
  return {
    request: () => ({ method: () => "POST" }),
    url: () =>
      "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo?from=profile",
    status: () => 200,
    ok: () => true,
    body: async () => Buffer.from(body),
  };
}

describe("Playwright session response probes", () => {
  it("resolves a detector registered after headers arrive while the body is pending", async () => {
    const { client, pageEvents } = fixture();
    let complete!: (body: Buffer) => void;
    pageEvents.emit("response", {
      ...accountResponse("{}"),
      body: () =>
        new Promise<Buffer>((resolve) => {
          complete = resolve;
        }),
    });
    const waiting = client.waitForJsonResponse({
      method: "POST",
      url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo",
      timeoutMs: 100,
    });
    complete(Buffer.from('{"data":{"userId":"42"}}'));
    await expect(waiting).resolves.toMatchObject({
      status: 200,
      body: { data: { userId: "42" } },
    });
    client.dispose();
  });

  it("disposes a waiter even while its response body is still pending", async () => {
    const { client, pageEvents } = fixture();
    const waiting = client.waitForJsonResponse({
      method: "POST",
      url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo",
      timeoutMs: 10_000,
    });
    let complete!: (body: Buffer) => void;
    pageEvents.emit("response", {
      ...accountResponse("{}"),
      body: () =>
        new Promise<Buffer>((resolve) => {
          complete = resolve;
        }),
    });
    client.dispose();
    await expect(waiting).resolves.toBeNull();
    complete(Buffer.from('{"data":{"userId":"42"}}'));
    expect(pageEvents.listenerCount("response")).toBe(0);
  });
  it("matches method, origin and path while ignoring query parameters", async () => {
    const { client, pageEvents } = fixture();
    const waiting = client.waitForJsonResponse({
      method: "POST",
      url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo",
      timeoutMs: 100,
    });

    pageEvents.emit(
      "response",
      accountResponse('{"data":{"userId":"kuaishou-42"}}'),
    );

    await expect(waiting).resolves.toEqual({
      status: 200,
      ok: true,
      body: { data: { userId: "kuaishou-42" } },
    });
  });

  it("replays the latest valid observed response to later detection attempts", async () => {
    const { client, pageEvents } = fixture();
    pageEvents.emit(
      "response",
      accountResponse('{"data":{"userId":"kuaishou-42"}}'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      client.waitForJsonResponse({
        method: "POST",
        url: "https://cp.kuaishou.com/rest/cp/creator/pc/home/userInfo",
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("notifies scoped observers and removes the page listener on dispose", async () => {
    const { client, pageEvents } = fixture();
    const observed = vi.fn();
    client.subscribeObservedResponses(observed);

    pageEvents.emit(
      "response",
      accountResponse('{"data":{"userId":"kuaishou-42"}}'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observed).toHaveBeenCalledOnce();
    expect(pageEvents.listenerCount("response")).toBe(1);
    client.dispose();
    expect(pageEvents.listenerCount("response")).toBe(0);
  });
});
