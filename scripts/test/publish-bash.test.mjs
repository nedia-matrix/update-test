import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = readFileSync(new URL("../publish.sh", import.meta.url), "utf8");
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const block = script.slice(
  script.indexOf('REMOTE_NAME="${GITHUB_REMOTE_NAME}"'),
  script.indexOf('echo "正在刷新目标项目的 Git Tags。"'),
);

function checkRemote(returnedUrl) {
  return spawnSync(
    bash,
    [
      "-uc",
      `
    TARGET_PATH=/test
    GITHUB_REMOTE_NAME=origin
    GIT_REMOTE=https://github.com/another-owner/desktop.git
    git() { printf '%s\n' "$*" >&2; printf '%s\n' "${returnedUrl}"; }
    ${block}
  `,
    ],
    { encoding: "utf8" },
  );
}

test("GitHub fetch/push checks work under nounset without real publication", () => {
  const result = checkRemote("https://github.com/another-owner/desktop.git");
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stderr.trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /get-url origin$/);
  assert.match(calls[1], /get-url --push --all origin$/);
});

test("rejects a different remote from the configured publication destination", () => {
  const result = checkRemote("https://github.com/nedia-matrix/desktop.git");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /停止发布/);
});

test("publication destination preview keeps a single identity and rejects obsolete options", () => {
  const path = new URL("../publish.sh", import.meta.url).pathname;
  const result = spawnSync(
    bash,
    [
      path,
      "--repository",
      "another-owner/desktop",
      "--target-directory",
      "../another-desktop",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /https:\/\/github.com\/another-owner\/desktop.git/,
  );
  for (const args of [
    ["--profile", "test"],
    ["--version", "0.4.0"],
    ["--repository", "another-owner/desktop"],
    ["--repository", "../bad"],
  ]) {
    const rejected = spawnSync(bash, [path, ...args, "--dry-run"], {
      encoding: "utf8",
    });
    assert.equal(rejected.status, 1);
  }
});
