import { DEFAULT_UPDATE_SOURCE_URL } from "../../bridge/update-source.js";
import { validatePublicUpdateUrl } from "./public-update-fetch.js";

export type UpdateSource =
  | { kind: "github"; url: string; repository: string }
  | { kind: "manifest"; url: string; signatureUrl: string };

export function parseUpdateSource(value: string | null): UpdateSource {
  if (value !== null && typeof value !== "string")
    throw new TypeError("更新地址必须为字符串或默认值");
  const url = validatePublicUpdateUrl(
    value === null ? DEFAULT_UPDATE_SOURCE_URL : value.trim(),
  );
  if (url.search || url.hash) throw new Error("更新入口不能包含查询参数或片段");
  if (url.hostname === "github.com") {
    const match =
      /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(
        url.pathname,
      );
    if (match && match[2] !== "." && match[2] !== "..") {
      const repository = `${match[1]}/${match[2]}`;
      return {
        kind: "github",
        url: `https://github.com/${repository}`,
        repository,
      };
    }
  }
  if (!url.pathname.endsWith("/update-manifest.json"))
    throw new Error(
      "请输入 GitHub 仓库地址或以 update-manifest.json 结尾的公开 HTTPS 地址",
    );
  return {
    kind: "manifest",
    url: url.href,
    signatureUrl: new URL("update-manifest.sig", url).href,
  };
}
