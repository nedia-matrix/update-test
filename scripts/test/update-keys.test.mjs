import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateUpdateKeys } from "../generate-update-keys.mjs";
import { configuredPublicKeys } from "../update-keys.mjs";
import { signingConfiguration } from "../update-manifest.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "nedia-update-key-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    keyId: "test-key",
    privateDirectory: join(root, "private"),
    publicKeysPath: join(root, "public-keys.json"),
  };
}

test("generates matching keys with restricted permissions and supports file-based signing", async (t) => {
  const options = await setup(t);
  const result = await generateUpdateKeys(options);
  const publicKeys = await readFile(result.publicKeysPath, "utf8");
  const config = signingConfiguration({
    NEDIA_UPDATE_PUBLIC_KEYS: publicKeys,
    NEDIA_UPDATE_PRIVATE_KEY_FILE: result.privateFile,
  });
  assert.equal(config.keyId, "test-key");
  const message = Buffer.from("key-pair verification");
  assert.equal(
    verify(
      null,
      message,
      config.publicKey,
      sign(null, message, config.privateKey),
    ),
    true,
  );
  assert.deepEqual(Object.keys(JSON.parse(publicKeys)), ["test-key"]);
  assert.equal(publicKeys.includes("PRIVATE KEY"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(result.privateFile)).mode & 0o777, 0o600);
    assert.equal((await stat(options.privateDirectory)).mode & 0o777, 0o700);
  }
});

test("refuses to overwrite any existing key or public configuration", async (t) => {
  const options = await setup(t);
  const result = await generateUpdateKeys(options);
  const original = await readFile(result.privateFile);
  await assert.rejects(generateUpdateKeys(options), /禁止覆盖/);
  assert.deepEqual(await readFile(result.privateFile), original);
  const another = await setup(t);
  await writeFile(another.publicKeysPath, "existing configuration");
  await assert.rejects(generateUpdateKeys(another), /禁止覆盖/);
  assert.equal(
    await readFile(another.publicKeysPath, "utf8"),
    "existing configuration",
  );
});

test("rejects invalid identifiers and ambiguous signing keys; permits explicit public overrides", async (t) => {
  const options = await setup(t);
  await assert.rejects(
    generateUpdateKeys({ ...options, keyId: "../invalid" }),
    /ID 无效/,
  );
  await assert.rejects(
    generateUpdateKeys({ ...options, keyId: undefined }),
    /ID 无效/,
  );
  const result = await generateUpdateKeys(options);
  const keys = JSON.parse(await readFile(result.publicKeysPath, "utf8"));
  const multiple = { ...keys, another: keys["test-key"] };
  assert.throws(
    () =>
      signingConfiguration({
        NEDIA_UPDATE_PUBLIC_KEYS: JSON.stringify(multiple),
        NEDIA_UPDATE_PRIVATE_KEY_FILE: result.privateFile,
      }),
    /签名发布需要/,
  );
  assert.deepEqual(
    configuredPublicKeys({ NEDIA_UPDATE_PUBLIC_KEYS: "{}" }),
    {},
  );
});
