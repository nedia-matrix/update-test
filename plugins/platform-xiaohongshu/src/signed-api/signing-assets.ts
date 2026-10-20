/** Pinned plugin runtime assets. Distribution conditions are tracked in docs/references/platforms/xiaohongshu/SOURCES.txt. */
export const xhsSigningAssets = [
  {
    name: "xhs_web_sign.js",
    sha256: "fd70c5a55fc97663f403d6ee29086a6a5e70d78bb9d081bb608c671d572a1846",
  },
  {
    name: "xhs_sign_init.js",
    sha256: "79b226011ecd89e245642dbafd2dedf8909a6b3ed77cdca9062e84e6a4f2ec32",
  },
  {
    name: "xhs_sign_core.js",
    sha256: "021c29449f15bc26aa414a0579b4bd582d1d70bc9122a45eee24ce2933aabbc3",
  },
  {
    name: "xhs_sign_inject.js",
    sha256: "86ee161743f3dbb84ffe9764c736a2880819be067a47c0d2ecbca3472db41418",
  },
] as const;
export const xhsImagePermitEndpoint =
  "https://creator.xiaohongshu.com/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web";
export function readXhsSignature(
  value: unknown,
): Readonly<Record<string, string>> {
  const source = value as Record<string, unknown> | null;
  const keys = ["X-s", "X-t", "X-s-common", "X-B3-Traceid", "X-xray-traceid"];
  if (
    !source ||
    keys.some(
      (key) =>
        typeof source[key] !== "string" ||
        !source[key] ||
        /[\r\n]/.test(String(source[key])),
    ) ||
    !String(source["X-s"]).startsWith("XYS_") ||
    !/^\d+$/.test(String(source["X-t"]))
  )
    throw new Error("XHS signature headers invalid");
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, String(source[key])])),
  );
}
