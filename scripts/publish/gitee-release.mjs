import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openAsBlob } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateUpdateManifest,
  sha256File,
  updateArtifactTargets,
} from "./update-manifest.mjs";

const apiOrigin = "https://gitee.com";
const downloadHosts = new Set(["gitee.com", "foruda.gitee.com"]);
// Official ordinary-project limit. A larger allowance needs separate repository verification.
const attachmentLimit = 100_000_000;

export async function syncPublicGiteeTag({
  repository,
  version,
  commit,
  token,
  environment = process.env,
  fetcher = fetch,
  runGit = execFileSync,
}) {
  repository = giteeRepository(repository);
  updateArtifactTargets(version);
  if (!/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("同步 tag 须指定完整构建 SHA");
  if (!environment.GITHUB_REPOSITORY)
    throw new Error("同步公开 tag 需要 GITHUB_REPOSITORY 指定公开构建仓库");
  const github = giteeRepository(environment.GITHUB_REPOSITORY);
  const read = async (url, headers = {}) => {
    const response = await fetcher(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel();
      throw new Error("公开构建 commit 或 Gitee 身份核验失败");
    }
    return boundedJson(response);
  };
  // A private working copy must never be pushed to a public release repository.
  // Prove the exact reachable commit is already public, without a GitHub token.
  const publicRepository = await read(`https://api.github.com/repos/${github}`);
  const publicCommit = await read(
    `https://api.github.com/repos/${github}/git/commits/${commit}`,
  );
  if (
    publicRepository.full_name !== github ||
    publicRepository.private !== false ||
    publicCommit.sha !== commit
  )
    throw new Error("禁止同步尚未公开的 GitHub 构建 commit");
  const user = await read("https://gitee.com/api/v5/user", {
    Authorization: `Bearer ${token}`,
  });
  if (typeof user.login !== "string" || !/^[A-Za-z0-9_-]+$/.test(user.login))
    throw new Error("Gitee 身份无效");
  const env = { ...environment };
  for (const key of Object.keys(env))
    if (
      /^GIT_(CONFIG|TRACE|CURL_VERBOSE)/.test(key) ||
      /^(NEDIA_UPDATE_PRIVATE_KEY|NEDIA_UPDATE_PRIVATE_KEY_FILE|NEDIA_GITEE_TOKEN)$/.test(
        key,
      )
    )
      delete env[key];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://gitee.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user.login}:${token}`).toString("base64")}`,
  });
  try {
    runGit(
      "git",
      [
        "-c",
        "credential.helper=",
        "push",
        `https://gitee.com/${repository}.git`,
        `${commit}:refs/tags/v${version}`,
      ],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      },
    );
  } catch (error) {
    // Classify captured stderr; never echo server output or credential-bearing errors.
    const stderr = String(error?.stderr ?? "");
    let reason = "Git 推送失败，请检查写入权限、网络及已有 tag";
    if (/shallow update not allowed|shallow object/i.test(stderr))
      reason = "远端拒绝浅克隆历史；Gitee 作业须使用 checkout fetch-depth: 0";
    else if (
      /authentication failed|could not read Username|HTTP Basic: Access denied|returned error: (401|403)|incorrect username or password/i.test(
        stderr,
      )
    )
      reason =
        "Git HTTPS 认证或写入权限被拒绝；API 令牌可用不代表具有 Git 推送权限";
    else if (/already exists|would clobber existing tag/i.test(stderr))
      reason = "远端 tag 已存在且与本次推送冲突";
    else if (
      /pre-receive hook declined|protected tag|permission denied|not allowed to push/i.test(
        stderr,
      )
    )
      reason = "远端权限、保护规则或接收钩子拒绝推送";
    else if (
      /could not resolve host|failed to connect|timed out|connection reset/i.test(
        stderr,
      ) ||
      error?.code === "ETIMEDOUT"
    )
      reason = "连接 Gitee 失败或超时，请检查 runner 网络";
    throw new Error(`Gitee tag 同步失败：${reason}；不会强制覆盖`);
  }
}

export function giteeRepository(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    [".", ".."].includes(value.split("/")[1])
  )
    throw new Error("Gitee 仓库必须为 owner/repository");
  return value;
}

async function boundedJson(response) {
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new Error("Gitee API 元数据过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Gitee API JSON 响应无效");
    }
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

export function giteeClient({ repository, token, fetcher = fetch }) {
  repository = giteeRepository(repository);
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
    throw new Error("缺少有效的 Gitee 发布令牌");
  const base = `/api/v5/repos/${repository}`;
  const request = async (
    route,
    { method = "GET", body, missing = false } = {},
  ) => {
    let response;
    const upload = body instanceof FormData;
    const headers = { Accept: "application/json" };
    let progressTimer;
    try {
      if (upload) {
        body.set("access_token", token);
        const fileName = body.get("file").name;
        // Use the platform multipart encoder, including its exact Content-Length.
        const multipart = await new Response(body).blob();
        headers["Content-Type"] = multipart.type;
        headers["Content-Length"] = String(multipart.size);
        let sent = 0;
        const started = Date.now();
        const report = () =>
          console.log(
            `Gitee 上传进度：${fileName}，请求体已交给 HTTP 客户端 ${sent}/${multipart.size} 字节（${Math.floor((sent / multipart.size) * 100)}%），耗时 ${Math.floor((Date.now() - started) / 1000)} 秒${sent === multipart.size ? "，等待服务器响应" : ""}`,
          );
        progressTimer = setInterval(report, 15_000);
        body = (async function* () {
          for await (const chunk of multipart.stream()) {
            sent += chunk.length;
            yield chunk;
          }
          report();
        })();
      } else {
        headers.Authorization = `Bearer ${token}`;
      }
      response = await fetcher(`${apiOrigin}${base}${route}`, {
        method,
        body,
        ...(upload ? { duplex: "half" } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(upload ? 60 * 60_000 : 120_000),
        headers,
      });
    } catch (error) {
      const cause = error?.cause ?? error;
      const detail = [cause?.code, cause?.message]
        .filter((value) => typeof value === "string" && value.trim())
        .join(": ")
        .replaceAll(token, "[redacted]");
      throw new Error(
        `Gitee API ${method} ${route} 请求失败${detail ? `（${detail}）` : ""}`,
      );
    } finally {
      clearInterval(progressTimer);
    }
    if (missing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel();
      // Never print response bodies, redirects or headers that could echo credentials.
      throw new Error(
        `Gitee API ${method} ${route} 返回 HTTP ${response.status}`,
      );
    }
    return boundedJson(response);
  };
  const list = async (route) => {
    const result = [];
    for (let page = 1; page <= 20; page++) {
      const entries = await request(`${route}?per_page=100&page=${page}`);
      if (!Array.isArray(entries)) throw new Error("Gitee 列表响应无效");
      result.push(...entries);
      if (entries.length < 100) return result;
    }
    throw new Error("Gitee 列表超出检查预算");
  };
  return { request, list, repository };
}

function attachmentUrl(repository, releaseId, attachmentId) {
  if (
    ![releaseId, attachmentId].every((id) => Number.isSafeInteger(id) && id > 0)
  )
    throw new Error("Gitee 附件身份无效");
  return `${apiOrigin}/api/v5/repos/${repository}/releases/${releaseId}/attach_files/${attachmentId}/download`;
}

async function verifyPublicFile(url, expected, fetcher) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      !downloadHosts.has(parsed.hostname)
    )
      throw new Error("Gitee 附件重定向超出已验证下载来源");
    // Public download is deliberately a separate request with NO credentials.
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Gitee 附件重定向缺少地址");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Gitee 公开下载失败（HTTP ${response.status}）`);
    }
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > expected.size) throw new Error("Gitee 公开附件超过预期大小");
        hash.update(chunk);
      }
    } finally {
      await response.body.cancel().catch(() => {});
    }
    if (size !== expected.size || hash.digest("hex") !== expected.sha256)
      throw new Error(`Gitee 附件回读摘要不匹配：${expected.name}`);
    return;
  }
  throw new Error("Gitee 附件重定向次数过多");
}

async function localFile(directory, name) {
  const path = join(directory, name);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size <= 0 ||
    info.size > attachmentLimit
  )
    throw new Error(
      `Gitee 附件必须为真实文件且不超过 ${attachmentLimit} 字节：${name}`,
    );
  return { name, path, size: info.size, sha256: await sha256File(path) };
}

/** Check first; publishing is invoked explicitly by the CLI or release job. */
export async function publishGiteeRelease({
  directory,
  version,
  shell,
  repository,
  commit,
  token,
  environment = process.env,
  fetcher = fetch,
  checkOnly = false,
  syncTag = false,
  body = `NediaMatrix v${version}`,
}) {
  if (shell !== "mixed")
    throw new Error(
      "Gitee 必须使用 mixed（macOS Tauri / Windows Electron）发行",
    );
  const client = giteeClient({ repository, token, fetcher });
  repository = client.repository;
  if (!/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw new Error("Gitee 发布须固定到完整构建 commit SHA");
  const targets = updateArtifactTargets(version, shell);
  const names = [
    ...targets.map((target) => target.assetName),
    ...["arm64", "x64"].map((arch) => `NediaMatrix-${version}-mac-${arch}.dmg`),
  ];
  const temporary = await mkdtemp(join(tmpdir(), "nedia-gitee-release-"));
  try {
    // Complete local trust, provenance and size checks before ANY remote mutation.
    const files = await Promise.all(
      names.map((name) => localFile(directory, name)),
    );
    await generateUpdateManifest({
      directory,
      version,
      shell,
      source: "gitee",
      repository,
      environment,
      outputDirectory: temporary,
    });
    const repo = await client.request("");
    if (repo.full_name !== repository || repo.public !== true)
      throw new Error("Gitee 发布目标必须为指定公开仓库");
    const tag = `v${version}`;
    const stagingTag = `nedia-staging-${tag}`;
    const tags = await client.list("/tags");
    let targetTag = tags.find((entry) => entry.name === tag);
    if (targetTag && targetTag.commit?.sha !== commit)
      throw new Error("Gitee 已有 tag 与构建 commit 不一致");
    if (checkOnly)
      return {
        repository,
        version,
        shell,
        commit,
        tagPresent: !!targetTag,
        files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
      };
    if (!targetTag && syncTag) {
      await syncPublicGiteeTag({
        repository,
        version,
        commit,
        token,
        environment,
        fetcher,
      });
      targetTag = (await client.list("/tags")).find(
        (entry) => entry.name === tag,
      );
      if (targetTag?.commit?.sha !== commit)
        throw new Error("Gitee tag 同步后未指向构建 commit");
    }
    if (!targetTag)
      throw new Error("请先将构建 commit 的正式 tag 同步到 Gitee，再发布附件");
    const final = await client.request(`/releases/tags/${tag}`, {
      missing: true,
    });
    let release =
      final ??
      (await client.request(`/releases/tags/${stagingTag}`, { missing: true }));
    if (
      release &&
      (!Number.isSafeInteger(release.id) ||
        release.target_commitish !== commit ||
        (!final &&
          (release.tag_name !== stagingTag || release.prerelease !== true)) ||
        (final && (release.tag_name !== tag || release.prerelease === true)))
    )
      throw new Error("Gitee 已有发行记录与本次构建不一致，不能接管或覆盖");
    if (!release) {
      release = await client.request("/releases", {
        method: "POST",
        body: new URLSearchParams({
          tag_name: stagingTag,
          name: `NediaMatrix ${tag} (uploading)`,
          body: "附件上传与校验中。",
          prerelease: "true",
          target_commitish: commit,
        }),
      });
      if (
        !Number.isSafeInteger(release?.id) ||
        release.id <= 0 ||
        release.tag_name !== stagingTag ||
        release.prerelease !== true ||
        release.target_commitish !== commit
      )
        throw new Error("Gitee 暂存发行创建响应无效");
    }
    const id = release.id;
    const attachments = await client.list(`/releases/${id}/attach_files`);
    const knownNames = new Set([
      ...names,
      "update-manifest.json",
      "update-manifest.sig",
      "SHA256SUMS.txt",
    ]);
    if (
      attachments.some((entry) => !knownNames.has(entry.name)) ||
      new Set(attachments.map((entry) => entry.name)).size !==
        attachments.length
    )
      throw new Error("Gitee 暂存发行存在未知或重复附件");
    const ensure = async (file) => {
      let attachment = attachments.find((entry) => entry.name === file.name);
      if (!attachment) {
        if (final) throw new Error("已发布的 Gitee 版本缺少附件，禁止补写");
        const form = new FormData();
        form.set("file", await openAsBlob(file.path), file.name);
        console.log(
          `Gitee 上传附件：${file.name}（${file.size} 字节，超时上限 60 分钟）`,
        );
        attachment = await client.request(`/releases/${id}/attach_files`, {
          method: "POST",
          body: form,
        });
        attachments.push(attachment);
      }
      if (attachment?.name !== file.name || attachment?.size !== file.size)
        throw new Error(`Gitee 附件身份或大小不匹配：${file.name}`);
      const url = attachmentUrl(repository, id, attachment.id);
      await verifyPublicFile(url, file, fetcher);
      return url;
    };
    const urls = {};
    for (const file of files) urls[file.name] = await ensure(file);
    await generateUpdateManifest({
      directory,
      version,
      shell,
      source: "gitee",
      repository,
      environment,
      outputDirectory: temporary,
      artifactUrls: Object.fromEntries(
        targets.map(({ assetName }) => [assetName, urls[assetName]]),
      ),
    });
    const metadata = await Promise.all(
      ["update-manifest.json", "update-manifest.sig"].map((name) =>
        localFile(temporary, name),
      ),
    );
    await writeFile(
      join(temporary, "SHA256SUMS.txt"),
      [...files, ...metadata]
        .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
        .join(""),
    );
    metadata.push(await localFile(temporary, "SHA256SUMS.txt"));
    for (const file of metadata) await ensure(file);
    if (!final) {
      // Gitee has no draft. A NON-semver staging tag cannot be offered by v0.3.2.
      // Download URLs use release/attachment IDs and remain fixed across this rename.
      await client.request(`/releases/${id}`, {
        method: "PATCH",
        body: new URLSearchParams({
          tag_name: tag,
          name: `NediaMatrix ${tag}`,
          body,
          prerelease: "false",
        }),
      });
    }
    const publicRelease = await fetcher(
      `${apiOrigin}/api/v5/repos/${repository}/releases/tags/${tag}`,
      { redirect: "manual", signal: AbortSignal.timeout(30000) },
    );
    if (!publicRelease.ok) throw new Error("Gitee 正式发行公开回读失败");
    const published = await boundedJson(publicRelease);
    if (
      published.id !== id ||
      published.tag_name !== tag ||
      published.prerelease !== false
    )
      throw new Error("Gitee 正式发行公开状态不符");
    return {
      repository,
      version,
      releaseId: id,
      status: final ? "verified-existing" : "published",
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, directory, version, shell, repository, commit, ...extra] =
    process.argv.slice(2);
  if (
    !["--check", "--publish"].includes(mode) ||
    !commit ||
    (extra.length && (extra.length !== 1 || extra[0] !== "--sync-public-tag"))
  ) {
    console.error(
      "用法：node scripts/publish/gitee-release.mjs <--check|--publish> <附件目录> <版本> <mixed> <owner/repository> <commit SHA> [--sync-public-tag]",
    );
    process.exitCode = 1;
  } else {
    try {
      if (shell !== "mixed")
        throw new Error(
          "Gitee 必须使用 mixed（macOS Tauri / Windows Electron）发行",
        );
      const token =
        process.env.NEDIA_GITEE_TOKEN ||
        (
          await readFile(
            process.env.NEDIA_GITEE_TOKEN_FILE || resolve(".local/gitee/token"),
            "utf8",
          )
        ).trim();
      console.log(
        JSON.stringify(
          await publishGiteeRelease({
            directory: resolve(directory),
            version,
            shell,
            repository,
            commit,
            token,
            checkOnly: mode === "--check",
            syncTag: extra.includes("--sync-public-tag"),
          }),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
