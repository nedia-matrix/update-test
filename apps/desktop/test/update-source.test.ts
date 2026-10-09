import { expect, it, vi } from "vitest";
import { parseUpdateSource } from "../src/main/updates/update-source.js";
import {
  isPublicAddress,
  resolvePublicAddresses,
} from "../src/main/updates/public-update-fetch.js";
import { fetchUpdateAsset } from "../src/main/updates/update-network.js";
import {
  findLatestRelease,
  releasePageUrl,
} from "../src/main/updates/application-update.js";

it("normalizes defaults, GitHub destinations and protocol siblings", () => {
  expect(parseUpdateSource(null).url).toBe(
    "https://github.com/nedia-matrix/desktop",
  );
  expect(
    parseUpdateSource(" https://github.com/another-owner/desktop/ "),
  ).toEqual({
    kind: "github",
    url: "https://github.com/another-owner/desktop",
    repository: "another-owner/desktop",
  });
  expect(
    parseUpdateSource(
      "https://updates.example.com/stable/update-manifest.json",
    ),
  ).toEqual({
    kind: "manifest",
    url: "https://updates.example.com/stable/update-manifest.json",
    signatureUrl: "https://updates.example.com/stable/update-manifest.sig",
  });
});

it.each([
  "http://example.com/update-manifest.json",
  "https://user:secret@example.com/update-manifest.json",
  "https://localhost/update-manifest.json",
  "https://127.1/update-manifest.json",
  "https://0x7f000001/update-manifest.json",
  "https://[::1]/update-manifest.json",
  "https://192.168.1.2/update-manifest.json",
  "https://host.local/update-manifest.json",
  "https://example.com:8443/update-manifest.json",
  "https://github.com/owner/repo/releases",
  "https://example.com/update-manifest.json?token=secret",
  "https://example.com/update-manifest.json#fragment",
])("rejects unsafe or unsupported source %s", (url) =>
  expect(() => parseUpdateSource(url)).toThrow(),
);

it.each([
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.31.1.1",
  "192.168.1.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.1.1.1",
  "255.255.255.255",
  "::1",
  "fc00::1",
  "fe80::1",
  "::ffff:7f00:1",
  "2001:db8::1",
  "2002:7f00:1::1",
  "2001::1",
  "3fff::1",
])("rejects reserved connection target %s", (address) =>
  expect(isPublicAddress(address)).toBe(false),
);

it("validates every DNS answer, including mixed public/private answers", async () => {
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  const resolver = vi.fn().mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await expect(
    resolvePublicAddresses("updates.example.com", resolver),
  ).rejects.toThrow("非公网");
  resolver.mockResolvedValue([]);
  await expect(
    resolvePublicAddresses("updates.example.com", resolver),
  ).rejects.toThrow();
  resolver.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  await expect(
    resolvePublicAddresses("updates.example.com", resolver),
  ).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
});

it("rejects a public endpoint redirecting to private address before the second request", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: {
        location: "https://169.254.169.254/update-manifest.json",
      },
    }),
  );
  await expect(
    fetchUpdateAsset(
      "https://updates.example.com/update-manifest.json",
      "manifest",
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses the configured GitHub repository rather than a build-time publishing profile", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ tag_name: "v0.4.0" })));
  await findLatestRelease(fetcher, "github", "another-owner/desktop");
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.github.com/repos/another-owner/desktop/releases/latest",
    expect.anything(),
  );
  expect(releasePageUrl("0.4.0", "github", "another-owner/desktop")).toBe(
    "https://github.com/another-owner/desktop/releases/tag/v0.4.0",
  );
});
