import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { publicUpdateFetch } from "../src/main/updates/public-update-fetch.js";

beforeEach(() => {
  mocks.lookup
    .mockReset()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockReset().mockImplementation((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      options.lookup(
        "updates.example.com",
        {},
        (error: unknown, address: string, family: number) => {
          expect(error).toBeNull();
          expect(address).toBe("8.8.8.8");
          expect(family).toBe(4);
        },
      );
      const response = Object.assign(Readable.from([Buffer.from("payload")]), {
        headers: {},
        statusCode: 200,
      });
      callback(response);
    };
    return req;
  });
});

it("pins verified DNS in the real request options without forwarding credentials or pooling", async () => {
  const response = await publicUpdateFetch(
    "https://updates.example.com/package.zip",
    {
      headers: {
        Authorization: "secret",
        Cookie: "secret",
        Accept: "application/json",
      },
    },
  );
  expect(await response.text()).toBe("payload");
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  const [url, options] = mocks.request.mock.calls[0]!;
  expect(url.hostname).toBe("updates.example.com");
  expect(options).toMatchObject({
    agent: false,
    family: 4,
    headers: { Accept: "application/json" },
  });
  expect(options.headers.Authorization).toBeUndefined();
  expect(options.headers.Cookie).toBeUndefined();
});

it("does not establish a socket when DNS contains any forbidden address", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  await expect(
    publicUpdateFetch("https://updates.example.com/package.zip"),
  ).rejects.toThrow("非公网");
  expect(mocks.request).not.toHaveBeenCalled();
});

it("cancels while DNS resolution is still pending", async () => {
  mocks.lookup.mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController();
  const pending = publicUpdateFetch("https://updates.example.com/package.zip", {
    signal: abort.signal,
  });
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});
