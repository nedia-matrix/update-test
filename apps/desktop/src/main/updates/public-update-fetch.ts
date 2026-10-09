import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const n = parts.reduce((value, part) => value * 256 + part, 0);
    const blocked: Array<[number[], number]> = [
      [[0], 8],
      [[10], 8],
      [[100, 64], 10],
      [[127], 8],
      [[169, 254], 16],
      [[172, 16], 12],
      [[192, 0, 0], 24],
      [[192, 0, 2], 24],
      [[192, 88, 99], 24],
      [[192, 168], 16],
      [[198, 18], 15],
      [[198, 51, 100], 24],
      [[203, 0, 113], 24],
      [[224], 3],
    ];
    return !blocked.some(([prefix, bits]) => {
      const base = Array.from(
        { length: 4 },
        (_, index) => prefix[index] ?? 0,
      ).reduce((value, part) => value * 256 + part, 0);
      return (
        Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits))
      );
    });
  }
  if (family !== 6 || address.includes(".")) return false;
  const halves = address.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ].map((word) => parseInt(word, 16));
  // Only global unicast, excluding special-purpose and transition ranges.
  return (
    words[0]! >= 0x2000 &&
    words[0]! <= 0x3fff &&
    !(words[0] === 0x2001 && (words[1]! < 0x200 || words[1] === 0xdb8)) &&
    words[0] !== 0x2002 &&
    !(words[0] === 0x3fff && words[1]! < 0x1000)
  );
}

export function validatePublicUpdateUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    !hostname ||
    hostname === "localhost" ||
    /\.(localhost|local|internal)$/.test(hostname) ||
    (isIP(hostname) ? !isPublicAddress(hostname) : !hostname.includes("."))
  )
    throw new Error(
      "更新地址必须为不含凭据的公开 HTTPS 地址，不能访问本机或私有网络",
    );
  return url;
}

export async function resolvePublicAddresses(
  hostname: string,
  resolver = lookup,
) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("更新地址解析到了非公网地址，已拒绝连接");
  return addresses;
}

/** DNS is validated once and pinned into the actual socket; no proxy or pooled socket bypass. */
export const publicUpdateFetch: typeof fetch = async (input, init = {}) => {
  const url = validatePublicUpdateUrl(String(input));
  if (init.method && init.method !== "GET")
    throw new Error("更新网络只允许 GET");
  const signal = init.signal ?? AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const addresses = await new Promise<
    Awaited<ReturnType<typeof resolvePublicAddresses>>
  >((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    resolvePublicAddresses(url.hostname)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const pinned = addresses[0]!;
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "NediaMatrix-update",
      Accept: "application/json, application/octet-stream",
      "Accept-Encoding": "identity",
    };
    const supplied = new Headers(init.headers);
    for (const name of ["Accept", "User-Agent", "X-GitHub-Api-Version"]) {
      const value = supplied.get(name);
      if (value) headers[name] = value;
    }
    const req = request(
      url,
      {
        method: "GET",
        headers,
        signal,
        agent: false,
        family: pinned.family,
        maxHeaderSize: 16 * 1024,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(
              name,
              Array.isArray(value) ? value.join(", ") : value,
            );
        }
        const status = response.statusCode ?? 500;
        let body: Readable = response;
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "deflate"
                ? createInflate()
                : encoding === "br"
                  ? createBrotliDecompress()
                  : undefined;
          if (!decoder) {
            response.destroy();
            reject(new Error("不支持的更新响应编码"));
            return;
          }
          response.on("error", (error) => decoder.destroy(error));
          body = response.pipe(decoder);
          decoder.on("close", () => response.destroy());
          responseHeaders.delete("content-length");
          responseHeaders.delete("content-encoding");
        }
        if ([204, 205, 304].includes(status)) {
          response.resume();
          resolve(new Response(null, { status, headers: responseHeaders }));
        } else
          resolve(
            new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
              status,
              headers: responseHeaders,
            }),
          );
      },
    );
    req.on("error", reject);
    req.end();
  });
};
