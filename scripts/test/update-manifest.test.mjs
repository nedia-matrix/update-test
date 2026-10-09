import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateUpdateManifest,
  publicKeyFingerprint,
  signingConfiguration,
  updateArtifactTargets,
} from "../update-manifest.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "nedia-manifest-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const environment = {
    NEDIA_UPDATE_KEY_ID: "test",
    NEDIA_UPDATE_PUBLIC_KEYS: JSON.stringify({ test: publicPem }),
    NEDIA_UPDATE_PRIVATE_KEY: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
  const contents = Buffer.from("dummy package\n");
  for (const artifact of updateArtifactTargets("0.4.0")) {
    const file = join(directory, artifact.assetName);
    await writeFile(file, contents);
    await writeFile(
      `${file}.provenance.json`,
      JSON.stringify({
        version: "0.4.0",
        appId: "com.nediamatrix.desktop",
        platform: artifact.platform,
        arch: artifact.arch,
        distribution: artifact.distribution,
        sha256: createHash("sha256").update(contents).digest("hex"),
        trustedKeyFingerprints: [publicKeyFingerprint(publicPem)],
      }),
    );
  }
  return {
    directory,
    environment,
    publicKey,
    options: { directory, environment, version: "0.4.0", source: "github" },
  };
}

test("produces deterministic raw-byte signatures, complete targets and exact file sizes/hashes", async (t) => {
  const { options, publicKey } = await fixture(t);
  const [manifestPath, signaturePath] = await generateUpdateManifest(options);
  const originalBytes = await readFile(manifestPath);
  const signature = JSON.parse(await readFile(signaturePath, "utf8"));
  assert.equal(
    verify(
      null,
      originalBytes,
      publicKey,
      Buffer.from(signature.signature, "base64"),
    ),
    true,
  );
  const manifest = JSON.parse(originalBytes);
  assert.equal(Object.hasOwn(manifest, "schemaVersion"), false);
  assert.equal(manifest.artifacts.length, 4);
  for (const artifact of manifest.artifacts) {
    const contents = await readFile(
      join(options.directory, artifact.assetName),
    );
    assert.equal(artifact.size, contents.length);
    assert.equal(
      artifact.sha256,
      createHash("sha256").update(contents).digest("hex"),
    );
  }
  await generateUpdateManifest(options);
  assert.deepEqual(await readFile(manifestPath), originalBytes);
  assert.deepEqual(
    JSON.parse(await readFile(signaturePath, "utf8")),
    signature,
  );
});

test("rejects missing/incorrect keys without writing a manifest", async (t) => {
  const { options, directory, environment } = await fixture(t);
  assert.throws(() => signingConfiguration({}), /签名发布需要/);
  const { publicKey } = generateKeyPairSync("ed25519");
  const wrongKeys = JSON.stringify({
    test: publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  await assert.rejects(
    generateUpdateManifest({
      ...options,
      environment: { ...environment, NEDIA_UPDATE_PUBLIC_KEYS: wrongKeys },
    }),
    /不匹配/,
  );
  await assert.rejects(readFile(join(directory, "update-manifest.json")), {
    code: "ENOENT",
  });
});

test("rejects cross-source, tampered, incomplete and untrusted-build artifacts", async (t) => {
  const { options, directory } = await fixture(t);
  await assert.rejects(
    generateUpdateManifest({ ...options, source: "unsupported" }),
    /更新源/,
  );
  const file = join(directory, updateArtifactTargets("0.4.0")[0].assetName);
  const original = await readFile(file);
  await writeFile(file, "changed");
  await assert.rejects(generateUpdateManifest(options), /构建来源/);
  await writeFile(file, original);
  const provenance = JSON.parse(
    await readFile(`${file}.provenance.json`, "utf8"),
  );
  await writeFile(
    `${file}.provenance.json`,
    JSON.stringify({ ...provenance, trustedKeyFingerprints: [] }),
  );
  await assert.rejects(generateUpdateManifest(options), /受信公钥/);
  await rm(file);
  await assert.rejects(generateUpdateManifest(options), { code: "ENOENT" });
});

test("rejects unsupported sources and unstable versions", async (t) => {
  const { options } = await fixture(t);
  assert.throws(() => updateArtifactTargets("v0.4.0"));
  assert.throws(() => updateArtifactTargets("0.4.0-beta"));
  await assert.rejects(
    generateUpdateManifest({ ...options, source: "arbitrary" }),
    /更新源/,
  );
});

test("the same build supports different GitHub destinations with signed URLs", async (t) => {
  const { options, publicKey } = await fixture(t);
  for (const repository of ["nedia-matrix/desktop", "another-owner/desktop"]) {
    const paths = await generateUpdateManifest({ ...options, repository });
    assert.equal(paths.length, 2);
    const bytes = await readFile(paths[0]);
    const signature = JSON.parse(await readFile(paths[1], "utf8"));
    assert.equal(
      verify(
        null,
        bytes,
        publicKey,
        Buffer.from(signature.signature, "base64"),
      ),
      true,
    );
    const manifest = JSON.parse(bytes);
    assert.equal(Object.hasOwn(manifest, "schemaVersion"), false);
    assert.equal(manifest.appId, "com.nediamatrix.desktop");
    assert.equal(manifest.source, undefined);
    assert.equal(
      manifest.artifacts[0].url,
      `https://github.com/${repository}/releases/download/v0.4.0/NediaMatrix-0.4.0-mac-arm64.zip`,
    );
  }
  await assert.rejects(
    generateUpdateManifest({ ...options, repository: "../bad" }),
  );
});

test("rejects builds with another product or mismatched architecture", async (t) => {
  const { options, directory } = await fixture(t);
  const file = join(
    directory,
    `${updateArtifactTargets("0.4.0")[0].assetName}.provenance.json`,
  );
  const provenance = JSON.parse(await readFile(file, "utf8"));
  for (const patch of [
    { appId: "another.product" },
    { arch: "x64" },
    { platform: "win32" },
  ]) {
    await writeFile(file, JSON.stringify({ ...provenance, ...patch }));
    await assert.rejects(generateUpdateManifest(options), /构建来源/);
  }
});
