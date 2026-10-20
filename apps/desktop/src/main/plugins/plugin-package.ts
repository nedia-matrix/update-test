import { createHash, verify } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PlatformPluginManifest } from "@nedia-matrix/platform-sdk";

export const pluginSignatureContext = "nedia.platform-plugin/v1\n";
export const maxPluginBytes = 32 * 1024 * 1024;
export const pluginHostCapabilities = [
  "browser",
  "scripts",
  "network",
  "media",
];
export interface PluginArchive {
  manifest: string;
  signature: { keyId: string; value: string };
  files: { path: string; data: string }[];
}
export interface VerifiedPlugin {
  archive: PluginArchive;
  manifest: PlatformPluginManifest;
  digest: string;
  files: Map<string, Buffer>;
}
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function safePluginPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 180 &&
    path
      .split("/")
      .every(
        (p) =>
          /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p) &&
          !p.endsWith(".") &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
      ) &&
    !["manifest.json", "manifest.sig", "package.json"].includes(
      path.toLowerCase(),
    )
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function verifyPluginArchive(
  bytes: Uint8Array,
  keys: Readonly<Record<string, string>>,
): VerifiedPlugin {
  if (bytes.byteLength > maxPluginBytes) throw new Error("插件包超过大小限制");
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !object(raw) ||
    typeof raw.manifest !== "string" ||
    Buffer.byteLength(raw.manifest) > 65536 ||
    !object(raw.signature) ||
    typeof raw.signature.keyId !== "string" ||
    typeof raw.signature.value !== "string" ||
    !Array.isArray(raw.files) ||
    !raw.files.length ||
    raw.files.length > 256
  )
    throw new Error("插件包格式无效");
  const key = keys[raw.signature.keyId];
  if (
    !key ||
    !/^[A-Za-z0-9+/]{86}==$/.test(raw.signature.value) ||
    !verify(
      null,
      Buffer.from(pluginSignatureContext + raw.manifest),
      key,
      Buffer.from(raw.signature.value, "base64"),
    )
  )
    throw new Error("插件签名校验失败");
  const manifest: unknown = JSON.parse(raw.manifest);
  if (
    !object(manifest) ||
    manifest.kind !== "nedia.platform-plugin" ||
    manifest.protocol !== 1 ||
    manifest.sdk !== 1 ||
    manifest.automation !== 1
  )
    throw new Error("插件协议或 SDK 不兼容");
  if (
    typeof manifest.platformId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(manifest.platformId) ||
    manifest.id !== `platform.${manifest.platformId}` ||
    typeof manifest.version !== "string" ||
    !manifest.version ||
    manifest.version.length > 64 ||
    typeof manifest.displayName !== "string" ||
    !manifest.displayName.trim() ||
    manifest.displayName.length > 100 ||
    !safePluginPath(manifest.entry) ||
    !manifest.entry.endsWith(".mjs") ||
    (manifest.icon !== undefined && !safePluginPath(manifest.icon)) ||
    !Array.isArray(manifest.capabilities) ||
    !manifest.capabilities.every(
      (v) => typeof v === "string" && pluginHostCapabilities.includes(v),
    ) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== raw.files.length
  )
    throw new Error("插件清单无效或所需宿主能力不可用");
  const files = new Map<string, Buffer>();
  const paths = new Set<string>();
  let total = 0;
  for (const file of raw.files) {
    if (
      !object(file) ||
      !safePluginPath(file.path) ||
      typeof file.data !== "string" ||
      file.data.length > maxPluginBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.data,
      ) ||
      paths.has(file.path.toLowerCase())
    )
      throw new Error("插件文件路径、内容或重复条目无效");
    const payload = Buffer.from(file.data, "base64");
    total += payload.byteLength;
    if (total > 24 * 1024 * 1024) throw new Error("插件载荷超过大小限制");
    paths.add(file.path.toLowerCase());
    files.set(file.path, payload);
  }
  const declared = new Set<string>();
  for (const item of manifest.files) {
    if (
      !object(item) ||
      !safePluginPath(item.path) ||
      declared.has(item.path.toLowerCase()) ||
      !Number.isSafeInteger(item.size) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("插件文件清单无效");
    const payload = files.get(item.path);
    if (
      !payload ||
      payload.byteLength !== item.size ||
      sha256(payload) !== item.sha256
    )
      throw new Error("插件文件完整性校验失败");
    declared.add(item.path.toLowerCase());
  }
  if (!files.has(manifest.entry)) throw new Error("插件入口缺失");
  if (
    manifest.icon !== undefined &&
    (!files.has(manifest.icon as string) ||
      !/\.(svg|png|webp)$/i.test(manifest.icon as string) ||
      files.get(manifest.icon as string)!.length > 128 * 1024)
  )
    throw new Error("插件图标缺失、格式无效或过大");
  for (const path of files.keys())
    if ([...files.keys()].some((other) => other.startsWith(path + "/")))
      throw new Error("插件路径类型冲突");
  return {
    archive: raw as unknown as PluginArchive,
    manifest: manifest as unknown as PlatformPluginManifest,
    digest: sha256(raw.manifest),
    files,
  };
}

/** Verify installed bytes again before import; reject links and undeclared resources. */
export function verifyInstalledPlugin(
  directory: string,
  keys: Readonly<Record<string, string>>,
): VerifiedPlugin {
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("插件目录不能为链接");
  const found: string[] = [];
  let entries = 0,
    total = 0;
  const walk = (prefix = "") => {
    for (const entry of readdirSync(join(directory, prefix), {
      withFileTypes: true,
    })) {
      if (++entries > 512) throw new Error("插件条目数量超限");
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error("插件不能包含链接");
      if (entry.isDirectory()) walk(path + "/");
      else if (entry.isFile()) {
        const size = lstatSync(join(directory, path)).size;
        total += size;
        if (
          total > 24 * 1024 * 1024 ||
          size > maxPluginBytes ||
          ((path === "manifest.json" || path === "manifest.sig") &&
            size > 65536)
        )
          throw new Error("插件文件大小超限");
        found.push(path);
      } else throw new Error("插件文件类型无效");
      if (found.length > 258) throw new Error("插件文件数量超限");
    }
  };
  walk();
  const manifest = readFileSync(join(directory, "manifest.json"), "utf8");
  const signature: unknown = JSON.parse(
    readFileSync(join(directory, "manifest.sig"), "utf8"),
  );
  const files = found
    .filter((p) => p !== "manifest.json" && p !== "manifest.sig")
    .map((path) => {
      if (lstatSync(join(directory, path)).size > maxPluginBytes)
        throw new Error("插件文件过大");
      return {
        path,
        data: readFileSync(join(directory, path)).toString("base64"),
      };
    });
  return verifyPluginArchive(
    Buffer.from(JSON.stringify({ manifest, signature, files })),
    keys,
  );
}

/** Image bytes come only from the verified payload; no filesystem paths reach Renderer. */
export function pluginIconUrl(plugin: VerifiedPlugin): string | undefined {
  const path = plugin.manifest.icon ?? "icon.svg";
  const bytes = plugin.files.get(path);
  if (!bytes || bytes.length > 128 * 1024) return undefined;
  const extension = path.toLowerCase();
  const mime = extension.endsWith(".svg")
    ? "image/svg+xml"
    : extension.endsWith(".png")
      ? "image/png"
      : extension.endsWith(".webp")
        ? "image/webp"
        : undefined;
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : undefined;
}
