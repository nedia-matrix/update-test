import {
  publicHttpsFetch,
  validatePublicHttpsUrl,
} from "../network/public-https-fetch.js";

export {
  isPublicAddress,
  resolvePublicAddresses,
} from "../network/public-https-fetch.js";

export function validatePublicUpdateUrl(value: string): URL {
  const url = validatePublicHttpsUrl(value);
  if ((url.port && url.port !== "443") || url.hash)
    throw new Error("更新地址必须使用默认 HTTPS 端口且不能包含片段");
  return url;
}

export const publicUpdateFetch: typeof fetch = async (input, init) => {
  validatePublicUpdateUrl(String(input));
  return publicHttpsFetch(input, init);
};
