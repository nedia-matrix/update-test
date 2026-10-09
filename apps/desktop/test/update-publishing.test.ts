import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { verifyUpdateManifest } from "../src/main/updates/update-manifest.js";
import { updateFixture } from "./update-fixtures.js";

it.each(["github"] as const)(
  "accepts actual publication-script output in the %s client",
  async (source) => {
    const directory = await mkdtemp(
      join(tmpdir(), "nedia-publish-integration-"),
    );
    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicPem = publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      const keyFingerprint = createHash("sha256")
        .update(publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      const fixture = updateFixture();
      for (const artifact of fixture.manifest.artifacts) {
        const file = join(directory, artifact.assetName);
        await writeFile(file, fixture.contents);
        await writeFile(
          `${file}.provenance.json`,
          JSON.stringify({
            version: fixture.manifest.version,
            appId: "com.nediamatrix.desktop",
            platform: artifact.platform,
            arch: artifact.arch,
            distribution: artifact.distribution,
            sha256: artifact.sha256,
            trustedKeyFingerprints: [keyFingerprint],
          }),
        );
      }
      const script = fileURLToPath(
        new URL("../../../scripts/update-manifest.mjs", import.meta.url),
      );
      await promisify(execFile)(
        process.execPath,
        [script, directory, fixture.manifest.version, source],
        {
          env: {
            ...process.env,
            NEDIA_UPDATE_KEY_ID: "test",
            NEDIA_UPDATE_PUBLIC_KEYS: JSON.stringify({ test: publicPem }),
            NEDIA_UPDATE_PRIVATE_KEY: privateKey
              .export({ format: "pem", type: "pkcs8" })
              .toString(),
          },
        },
      );
      const manifest = verifyUpdateManifest(
        await readFile(join(directory, "update-manifest.json")),
        await readFile(join(directory, "update-manifest.sig")),
        { test: publicPem },
        { version: fixture.manifest.version },
      );
      expect(manifest).toMatchObject({
        appId: "com.nediamatrix.desktop",
        version: fixture.manifest.version,
        artifacts: fixture.manifest.artifacts,
      });
      expect(
        manifest.artifacts.every((artifact) =>
          artifact.url?.startsWith("https://github.com/"),
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
