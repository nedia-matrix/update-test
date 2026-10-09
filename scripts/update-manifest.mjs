#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredPublicKeys } from "./update-keys.mjs";

export function updateArtifactTargets(version) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !version.split(".").every((part) => Number.isSafeInteger(Number(part)))
  )
    throw new Error("必须指定稳定版本号");
  return [
    {
      platform: "darwin",
      arch: "arm64",
      distribution: "app-zip",
      assetName: `NediaMatrix-${version}-mac-arm64.zip`,
    },
    {
      platform: "darwin",
      arch: "x64",
      distribution: "app-zip",
      assetName: `NediaMatrix-${version}-mac-x64.zip`,
    },
    {
      platform: "win32",
      arch: "x64",
      distribution: "nsis",
      assetName: `NediaMatrix-${version}-win-setup-x64.exe`,
    },
    {
      platform: "win32",
      arch: "x64",
      distribution: "portable",
      assetName: `NediaMatrix-${version}-win-portable-x64.exe`,
    },
  ];
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function publicKeyFingerprint(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("更新密钥必须使用 Ed25519");
  return createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function signingConfiguration(environment = process.env) {
  const keys = configuredPublicKeys(environment);
  const ids = Object.keys(keys ?? {});
  const keyId =
    environment.NEDIA_UPDATE_KEY_ID || (ids.length === 1 ? ids[0] : undefined);
  let privatePem = environment.NEDIA_UPDATE_PRIVATE_KEY;
  if (!privatePem && environment.NEDIA_UPDATE_PRIVATE_KEY_FILE) {
    const file = environment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error("私钥文件必须为真实文件，且仅当前用户可访问");
    privatePem = readFileSync(file, "utf8");
  }
  if (
    !keyId ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
    !privatePem ||
    !keys ||
    !Object.hasOwn(keys, keyId)
  ) {
    throw new Error(
      "签名发布需要私钥（NEDIA_UPDATE_PRIVATE_KEY 或 NEDIA_UPDATE_PRIVATE_KEY_FILE）及匹配的受信公钥；多把公钥时须指定 NEDIA_UPDATE_KEY_ID",
    );
  }
  const privateKey = createPrivateKey(privatePem);
  const publicKey = keys[keyId];
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKeyFingerprint(
      createPublicKey(privateKey).export({ format: "pem", type: "spki" }),
    ) !== publicKeyFingerprint(publicKey)
  ) {
    throw new Error("发布私钥与客户端受信公钥不匹配");
  }
  return { keyId, privateKey, publicKey };
}

/** Build identity is provider-independent; publication supplies artifact URLs. */
export async function generateUpdateManifest({
  directory,
  version,
  source,
  repository = process.env.GITHUB_REPOSITORY || "nedia-matrix/desktop",
  environment = process.env,
}) {
  if (source !== "github") throw new Error("更新源必须为 github");
  const configuration = signingConfiguration(environment);
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1])
  )
    throw new Error("GitHub 仓库必须为 owner/repository");
  const artifacts = [];
  for (const target of updateArtifactTargets(version)) {
    const file = join(directory, target.assetName);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 0
    )
      throw new Error(`更新载荷无效：${target.assetName}`);
    const sha256 = await sha256File(file);
    const provenance = JSON.parse(
      await readFile(`${file}.provenance.json`, "utf8"),
    );
    if (
      provenance.version !== version ||
      provenance.appId !== "com.nediamatrix.desktop" ||
      provenance.platform !== target.platform ||
      provenance.arch !== target.arch ||
      provenance.distribution !== target.distribution ||
      provenance.sha256 !== sha256 ||
      !provenance.trustedKeyFingerprints?.includes(
        publicKeyFingerprint(configuration.publicKey),
      )
    ) {
      throw new Error(
        `更新载荷的构建来源或受信公钥不匹配：${target.assetName}`,
      );
    }
    artifacts.push({ ...target, size: info.size, sha256 });
  }
  const basename = "update-manifest";
  const document = {
    appId: "com.nediamatrix.desktop",
    version,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(artifact.assetName)}`,
    })),
  };
  const manifest = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const signature = {
    keyId: configuration.keyId,
    algorithm: "Ed25519",
    signature: sign(null, manifest, configuration.privateKey).toString(
      "base64",
    ),
  };
  const manifestPath = join(directory, `${basename}.json`);
  const signaturePath = join(directory, `${basename}.sig`);
  await writeFile(manifestPath, manifest);
  await writeFile(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
  return [manifestPath, signaturePath];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 3 && args.length !== 4) {
    console.error(
      "用法：node scripts/update-manifest.mjs <附件目录> <版本（不含v）> <github> [owner/repository]",
    );
    process.exitCode = 1;
  } else {
    generateUpdateManifest({
      directory: resolve(args[0]),
      version: args[1],
      source: args[2],
      repository: args[3],
    })
      .then(() => {
        console.log("更新清单和 Ed25519 签名已生成。");
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
