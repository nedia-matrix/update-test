import { createHash, generateKeyPairSync, sign } from "node:crypto";

import type { ApplicationRelease } from "../src/main/updates/application-update.js";
import type { UpdateManifest } from "../src/main/updates/update-manifest.js";

export function updateFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = {
    test: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
  const contents = Buffer.from("test update package\n");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const manifest: UpdateManifest = {
    version: "0.4.0",
    appId: "com.nediamatrix.desktop",
    artifacts: [
      {
        platform: "darwin",
        arch: "arm64",
        distribution: "app-zip",
        assetName: "NediaMatrix-0.4.0-mac-arm64.zip",
        url: "https://github.com/nedia-matrix/desktop/releases/download/v0.4.0/NediaMatrix-0.4.0-mac-arm64.zip",
        size: contents.length,
        sha256,
      },
      {
        platform: "darwin",
        arch: "x64",
        distribution: "app-zip",
        assetName: "NediaMatrix-0.4.0-mac-x64.zip",
        url: "https://github.com/nedia-matrix/desktop/releases/download/v0.4.0/NediaMatrix-0.4.0-mac-x64.zip",
        size: contents.length,
        sha256,
      },
      {
        platform: "win32",
        arch: "x64",
        distribution: "nsis",
        assetName: "NediaMatrix-0.4.0-win-setup-x64.exe",
        url: "https://github.com/nedia-matrix/desktop/releases/download/v0.4.0/NediaMatrix-0.4.0-win-setup-x64.exe",
        size: contents.length,
        sha256,
      },
      {
        platform: "win32",
        arch: "x64",
        distribution: "portable",
        assetName: "NediaMatrix-0.4.0-win-portable-x64.exe",
        url: "https://github.com/nedia-matrix/desktop/releases/download/v0.4.0/NediaMatrix-0.4.0-win-portable-x64.exe",
        size: contents.length,
        sha256,
      },
    ],
  };
  const encode = (value: unknown = manifest) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const signature = Buffer.from(
      JSON.stringify({
        keyId: "test",
        algorithm: "Ed25519",
        signature: sign(null, bytes, privateKey).toString("base64"),
      }),
    );
    return { bytes, signature };
  };
  const url = (name: string) =>
    `https://github.com/nedia-matrix/desktop/releases/download/v0.4.0/${name}`;
  const release: ApplicationRelease = {
    version: manifest.version,
    assets: [
      ...manifest.artifacts.map((artifact) => artifact.assetName),
      "update-manifest.json",
      "update-manifest.sig",
    ].map((name) => ({ name, url: url(name) })),
  };
  return { keys, contents, manifest, encode, url, release };
}
