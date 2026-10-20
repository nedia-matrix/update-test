import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configuredPublicKeys } from "../publish/update-keys.mjs";
import { verifyPluginArchive } from "../../apps/desktop/src/main/plugins/plugin-package.ts";

const directory = process.argv[2];
if (!directory) throw new Error("缺少预装插件目录");
if (!existsSync(directory))
  throw new Error(
    "缺少签名预装插件。请配置 NEDIA_UPDATE_PRIVATE_KEY 或 NEDIA_UPDATE_PRIVATE_KEY_FILE 后重新打包；本地也可使用项目 .local/release-keys/private.pem。CI/正式发行须先运行 plugins:build。",
  );
const keys = configuredPublicKeys();
if (Object.hasOwn(keys, "development-only"))
  throw new Error("发行信任配置不能包含开发密钥");
const required = new Set(["douyin", "kuaishou", "xiaohongshu"]);
for (const name of readdirSync(directory).filter((name) =>
  name.endsWith(".nmp"),
)) {
  const plugin = verifyPluginArchive(readFileSync(join(directory, name)), keys);
  if (!required.delete(plugin.manifest.platformId))
    throw new Error("预装插件平台重复或不受支持");
}
if (required.size)
  throw new Error("缺少完整的签名预装插件，请先运行 plugins:build");
