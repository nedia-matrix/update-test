import { describe, expect, it } from "vitest";
import {
  selectUpdateArtifact,
  verifyUpdateManifest,
} from "../src/main/updates/update-manifest.js";
import { updateFixture } from "./update-fixtures.js";

describe("trusted update manifest", () => {
  it("verifies raw bytes and strictly selects platform, architecture and distribution", () => {
    const fixture = updateFixture();
    const { bytes, signature } = fixture.encode();
    const manifest = verifyUpdateManifest(bytes, signature, fixture.keys, {
      version: "0.4.0",
    });
    expect(manifest).toEqual(fixture.manifest);
    expect(
      selectUpdateArtifact(manifest, {
        platform: "win32",
        arch: "x64",
        distribution: "portable",
      })?.assetName,
    ).toContain("portable");
    expect(
      selectUpdateArtifact(manifest, {
        platform: "darwin",
        arch: "x64",
        distribution: "app-zip",
      })?.arch,
    ).toBe("x64");
    expect(
      selectUpdateArtifact(manifest, {
        platform: "win32",
        arch: "arm64",
        distribution: "portable",
      }),
    ).toBeUndefined();
  });

  it("rejects changed bytes, unknown keys, missing/invalid signatures and mismatched application identities/tags", () => {
    const fixture = updateFixture();
    const { bytes, signature } = fixture.encode();
    const expected = { version: "0.4.0" };
    expect(() =>
      verifyUpdateManifest(
        Buffer.concat([bytes, Buffer.from(" ")]),
        signature,
        fixture.keys,
        expected,
      ),
    ).toThrow("签名验证失败");
    expect(() => verifyUpdateManifest(bytes, signature, {}, expected)).toThrow(
      "受信密钥",
    );
    expect(() =>
      verifyUpdateManifest(bytes, Buffer.from("{}"), fixture.keys, expected),
    ).toThrow();
    expect(() =>
      verifyUpdateManifest(bytes, signature, fixture.keys, {
        ...expected,
        version: "unsupported",
      }),
    ).toThrow("不匹配");
    const wrongSource = fixture.encode({
      ...fixture.manifest,
      appId: "unsupported",
    });
    expect(() =>
      verifyUpdateManifest(
        wrongSource.bytes,
        wrongSource.signature,
        fixture.keys,
        expected,
      ),
    ).toThrow("不匹配");
    expect(() =>
      verifyUpdateManifest(bytes, signature, fixture.keys, {
        ...expected,
        version: "0.5.0",
      }),
    ).toThrow("不匹配");
  });

  it.each([
    "app-id",
    "incomplete",
    "duplicate-target",
    "duplicate-name",
    "path",
    "size",
    "digest",
    "platform",
    "extension",
    "prerelease",
    "null-artifact",
  ])("rejects even correctly signed invalid metadata: %s", (scenario) => {
    const fixture = updateFixture();
    const manifest = structuredClone(fixture.manifest);
    switch (scenario) {
      case "app-id":
        Object.assign(manifest, { appId: undefined });
        break;
      case "incomplete":
        manifest.artifacts.pop();
        break;
      case "duplicate-target":
        manifest.artifacts[1] = manifest.artifacts[0]!;
        break;
      case "duplicate-name":
        manifest.artifacts[1]!.assetName = manifest.artifacts[0]!.assetName;
        break;
      case "path":
        manifest.artifacts[0]!.assetName = "../evil.zip";
        break;
      case "size":
        manifest.artifacts[0]!.size = 1.1;
        break;
      case "digest":
        manifest.artifacts[0]!.sha256 = "a";
        break;
      case "platform":
        Object.assign(manifest.artifacts[0]!, { platform: "linux" });
        break;
      case "extension":
        manifest.artifacts[0]!.assetName = "evil.exe";
        break;
      case "prerelease":
        manifest.version = "0.4.0-beta";
        break;
      case "null-artifact":
        Object.assign(manifest.artifacts, { 0: null });
        break;
    }
    const { bytes, signature } = fixture.encode(manifest);
    expect(() =>
      verifyUpdateManifest(bytes, signature, fixture.keys, {
        version: manifest.version,
      }),
    ).toThrow();
  });
});
