import { describe, expect, it, vi } from "vitest";
import {
  fetchUpdateAsset,
  readBoundedResponse,
  validateUpdateUrl,
} from "../src/main/updates/update-network.js";

describe("update network boundaries", () => {
  it.each([
    "http://github.com/a",
    "https://github.com.evil.test/a",
    "https://user:secret@github.com/a",
    "https://github.com:444/a",
    "file:///tmp/a",
    "https://gitee.com/a",
    "https://foruda.gitee.com/a",
  ])("rejects an untrusted URL: %s", (url) => {
    expect(() => validateUpdateUrl(url, "github")).toThrow();
  });
  it("permits only verified provider/CDN hosts, not broad wildcard domains", () => {
    expect(
      validateUpdateUrl(
        "https://release-assets.githubusercontent.com/a",
        "github",
      ).hostname,
    ).toBe("release-assets.githubusercontent.com");
    expect(() =>
      validateUpdateUrl("https://evil.githubusercontent.com/a", "github"),
    ).toThrow();
  });
  it.each([
    "https://evil.test/payload",
    "https://gitee.com/payload",
    "https://foruda.gitee.com/payload",
  ])(
    "rejects a redirect to %s before making the next request",
    async (location) => {
      const fetcher = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location },
          }),
      );
      await expect(
        fetchUpdateAsset(
          "https://github.com/a",
          "github",
          AbortSignal.timeout(1000),
          fetcher,
        ),
      ).rejects.toThrow("受信来源");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("follows provider redirects without forwarding credentials and bounds loops", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/a",
          },
        }),
      )
      .mockResolvedValue(new Response("ok"));
    await expect(
      (
        await fetchUpdateAsset(
          "https://github.com/a",
          "github",
          AbortSignal.timeout(1000),
          fetcher,
        )
      ).text(),
    ).resolves.toBe("ok");
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://release-assets.githubusercontent.com/a",
      expect.objectContaining({ redirect: "manual" }),
    );
    const loop = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "/a" } }),
    );
    await expect(
      fetchUpdateAsset(
        "https://github.com/a",
        "github",
        AbortSignal.timeout(1000),
        loop,
      ),
    ).rejects.toThrow("次数过多");
    expect(loop).toHaveBeenCalledTimes(6);
  });
  it("rejects failed requests and oversized metadata", async () => {
    await expect(
      fetchUpdateAsset(
        "https://github.com/a",
        "github",
        AbortSignal.timeout(1000),
        async () => new Response("error", { status: 403 }),
      ),
    ).rejects.toThrow("403");
    await expect(
      readBoundedResponse(new Response("oversized"), 3),
    ).rejects.toThrow("大小限制");
    expect(
      Buffer.from(await readBoundedResponse(new Response("ok"), 3)).toString(),
    ).toBe("ok");
  });
});
