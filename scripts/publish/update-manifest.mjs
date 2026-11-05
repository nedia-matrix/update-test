#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredPublicKeys } from "./update-keys.mjs";

export function updateArtifactTargets(version, shell = "electron") {
  if (!["electron", "tauri", "mixed"].includes(shell))
    throw new Error("未知桌面发行类型");
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !version.split(".").every((part) => Number.isSafeInteger(Number(part)))
  )
    throw new Error("必须指定稳定版本号");
  const targets = [
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
  return targets;
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
  shell = "electron",
  outputDirectory = directory,
  artifactUrls,
}) {
  if (source !== "github" && source !== "gitee")
    throw new Error("更新源必须为 github 或 gitee");
  if (
    (source === "gitee" && shell !== "mixed") ||
    (source === "github" && shell !== "electron")
  )
    throw new Error(
      "Gitee 必须使用 mixed（macOS Tauri / Windows Electron）发行，GitHub 必须使用 electron（不接受 mixed 或 tauri）",
    );
  const configuration = signingConfiguration(environment);
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1])
  )
    throw new Error("发布仓库必须为 owner/repository");
  const targets = updateArtifactTargets(version, shell);
  if (
    artifactUrls &&
    (source !== "gitee" ||
      Object.keys(artifactUrls).length !== targets.length ||
      targets.some(({ assetName }) => !Object.hasOwn(artifactUrls, assetName)))
  )
    throw new Error("Gitee 附件地址必须完整对应四类载荷");
  const artifacts = [];
  const appId = "com.nediamatrix.desktop";
  for (const target of targets) {
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
    const expectedShell =
      shell === "mixed"
        ? { darwin: "tauri", win32: "electron" }[target.platform]
        : shell;
    if (
      provenance.shell !== expectedShell ||
      provenance.version !== version ||
      provenance.appId !== appId ||
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
    appId,
    version,
    artifacts: artifacts.map((artifact) => {
      const url =
        artifactUrls?.[artifact.assetName] ??
        `https://${source === "github" ? "github.com" : "gitee.com"}/${repository}/releases/download/v${version}/${encodeURIComponent(artifact.assetName)}`;
      if (artifactUrls) {
        const prefix = `https://gitee.com/api/v5/repos/${repository}/releases/`;
        if (
          typeof url !== "string" ||
          !url.startsWith(prefix) ||
          !/^[1-9]\d*\/attach_files\/[1-9]\d*\/download$/.test(
            url.slice(prefix.length),
          )
        )
          throw new Error("Gitee 载荷须使用本仓库的固定附件下载 API");
      }
      return { ...artifact, url };
    }),
  };
  const manifest = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  const signature = {
    keyId: configuration.keyId,
    algorithm: "Ed25519",
    signature: sign(null, manifest, configuration.privateKey).toString(
      "base64",
    ),
  };
  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = join(outputDirectory, `${basename}.json`);
  const signaturePath = join(outputDirectory, `${basename}.sig`);
  await writeFile(manifestPath, manifest);
  await writeFile(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
  return [manifestPath, signaturePath];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length < 3 || args.length > 5) {
    console.error(
      "用法：node scripts/publish/update-manifest.mjs <附件目录> <版本（不含v）> <github|gitee> [owner/repository] [electron|tauri|mixed]",
    );
    process.exitCode = 1;
  } else {
    generateUpdateManifest({
      directory: resolve(args[0]),
      version: args[1],
      source: args[2],
      repository: args[3],
      shell: args[4],
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
