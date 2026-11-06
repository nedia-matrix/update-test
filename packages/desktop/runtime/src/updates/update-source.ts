import {
  DEFAULT_UPDATE_SOURCE_URL,
  UPDATE_MANIFEST_NAME,
} from "@nedia-matrix/desktop-contracts/update-source";
import { validatePublicUpdateUrl } from "./public-update-fetch.js";

export type UpdateSource =
  | { kind: "github" | "gitee"; url: string; repository: string }
  | { kind: "manifest"; url: string; signatureUrl: string };

export function parseUpdateSource(value: string | null): UpdateSource {
  if (value !== null && typeof value !== "string")
    throw new TypeError("更新地址必须为字符串或默认值");
  const url = validatePublicUpdateUrl(
    value === null ? DEFAULT_UPDATE_SOURCE_URL : value.trim(),
  );
  if (url.search || url.hash) throw new Error("更新入口不能包含查询参数或片段");
  if (url.hostname === "github.com" || url.hostname === "gitee.com") {
    const pattern =
      url.hostname === "github.com"
        ? /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/
        : /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})\/?$/;
    const match = pattern.exec(url.pathname);
    if (match && match[2] !== "." && match[2] !== "..") {
      const repository = `${match[1]}/${match[2]}`;
      return {
        kind: url.hostname === "github.com" ? "github" : "gitee",
        url: `https://${url.hostname}/${repository}`,
        repository,
      };
    }
  }
  if (!url.pathname.endsWith(`/${UPDATE_MANIFEST_NAME}.json`))
    throw new Error(
      `请输入 GitHub / Gitee 仓库地址或以 ${UPDATE_MANIFEST_NAME}.json 结尾的公开 HTTPS 地址`,
    );
  return {
    kind: "manifest",
    url: url.href,
    signatureUrl: new URL(`${UPDATE_MANIFEST_NAME}.sig`, url).href,
  };
}
