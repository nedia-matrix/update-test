#!/usr/bin/env node
import { createRequire } from "node:module";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { configuredPublicKeys } from "../publish/update-keys.mjs";
import { signingConfiguration } from "../publish/update-manifest.mjs";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../.."),
  desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build, transformWithEsbuild } = await import(
  pathToFileURL(require.resolve("vite")).href
);
const development = process.argv.includes("--development");
// Resolve build tooling from the desktop workspace, just like Vite.
const obfuscator = development ? undefined : require("javascript-obfuscator");
const legacyXiaohongshu = process.argv.includes("--legacy-xiaohongshu");
const pluginSourceRoot = legacyXiaohongshu ? "plugins-legacy" : "plugins";
const output = resolve(
  process.env.NEDIA_PLUGIN_OUTPUT ||
    (legacyXiaohongshu
      ? join(
          root,
          ".local/platform-plugins-legacy",
          development ? "development" : "release",
        )
      : join(
          desktop,
          development ? ".plugins-development" : "resources/plugins",
        )),
);
const work = legacyXiaohongshu
  ? join(root, ".local/platform-plugins-legacy/work")
  : join(desktop, ".plugins-build");
const platforms = legacyXiaohongshu
  ? ["xiaohongshu"]
  : ["douyin", "xiaohongshu", "kuaishou", "mock"];
// Each plugin owns its release metadata. Application versions never supply a fallback.
const plugins = platforms.map((platform) => {
  const packageFile = join(
    root,
    `${pluginSourceRoot}/platform-${platform}/package.json`,
  );
  const { version } = JSON.parse(readFileSync(packageFile, "utf8"));
  if (
    typeof version !== "string" ||
    !version.trim() ||
    version !== version.trim() ||
    version.length > 64
  )
    throw new Error(
      `平台插件 ${platform} 缺少有效的独立版本（package.json.version）`,
    );
  return { platform, version };
});
const hash = (data) => createHash("sha256").update(data).digest("hex");
const filesIn = (dir, prefix = "") =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? filesIn(dir, prefix + item.name + "/")
      : [prefix + item.name],
  );
// Validate signing prerequisites before compiling. Local packages use the same official trust as release packages.
if (!development && Object.hasOwn(configuredPublicKeys(), "development-only"))
  throw new Error("发行信任配置不能包含开发密钥");
const releaseSigning = development ? undefined : signingConfiguration();
// Compile without running package scripts. Release credentials never enter Vite's environment.
const secret = process.env.NEDIA_UPDATE_PRIVATE_KEY;
const secretFile = process.env.NEDIA_UPDATE_PRIVATE_KEY_FILE;
delete process.env.NEDIA_UPDATE_PRIVATE_KEY;
delete process.env.NEDIA_UPDATE_PRIVATE_KEY_FILE;
try {
  for (const platform of platforms) {
    const directory = join(work, platform);
    await build({
      configFile: false,
      logLevel: "warn",
      resolve: {
        alias: [
          {
            find: /^@nedia-matrix\/platform-sdk$/,
            replacement: join(root, "packages/platforms/sdk/src/index.ts"),
          },
        ],
      },
      build: {
        outDir: directory,
        emptyOutDir: true,
        target: "node22",
        minify: false,
        sourcemap: false,
        lib: {
          entry: join(
            root,
            `${pluginSourceRoot}/platform-${platform}/src/${platform === "xiaohongshu" && !legacyXiaohongshu ? "plugin/index.ts" : "plugin.ts"}`,
          ),
          formats: ["es"],
          fileName: () => "entry.mjs",
        },
        rollupOptions: {
          external: [/^node:/],
          output: { inlineDynamicImports: true },
        },
      },
    });
    if (!development) {
      // Vite preserves whitespace for ES library builds. Minify the final entry explicitly.
      const entry = join(directory, "entry.mjs");
      const result = await transformWithEsbuild(
        readFileSync(entry, "utf8"),
        entry,
        {
          target: "node22",
          minify: true,
          legalComments: "none",
          sourcemap: false,
        },
      );
      // Keep public properties and exports intact. Browser-injected scripts are
      // separate, hash-pinned assets and must retain their original bytes.
      const obfuscated = obfuscator.obfuscate(result.code, {
        target: "node",
        compact: true,
        seed: parseInt(hash(result.code).slice(0, 7), 16) || 1,
        identifierNamesGenerator: "hexadecimal",
        renameGlobals: true,
        renameProperties: false,
        stringArray: true,
        stringArrayEncoding: ["base64"],
        stringArrayThreshold: 0.75,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        disableConsoleOutput: false,
        selfDefending: false,
        sourceMap: false,
      });
      writeFileSync(entry, obfuscated.getObfuscatedCode());
    }
  }
} finally {
  if (secret !== undefined) process.env.NEDIA_UPDATE_PRIVATE_KEY = secret;
  if (secretFile !== undefined)
    process.env.NEDIA_UPDATE_PRIVATE_KEY_FILE = secretFile;
}
let privateKey, keyId;
if (development) {
  const keyDirectory = join(root, ".local/platform-plugin-development");
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  const privatePath = join(keyDirectory, "private.pem");
  if (!existsSync(privatePath)) {
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(
      privatePath,
      pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
  }
  privateKey = createPrivateKey(readFileSync(privatePath));
  keyId = "development-only";
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "development-public-keys.json"),
    JSON.stringify({
      [keyId]: createPublicKey(privateKey).export({
        type: "spki",
        format: "pem",
      }),
    }),
  );
} else {
  ({ privateKey, keyId } = releaseSigning);
  mkdirSync(output, { recursive: true });
  rmSync(join(output, "development-public-keys.json"), { force: true });
}
for (const { platform, version } of plugins) {
  const directory = join(work, platform);
  const files = filesIn(directory).map((path) => ({
    path,
    bytes: readFileSync(join(directory, path)),
  }));
  {
    const assets = join(
      root,
      `${pluginSourceRoot}/platform-${platform}/assets`,
    );
    for (const path of filesIn(assets))
      files.push({
        path: `assets/${path}`,
        bytes: readFileSync(join(assets, path)),
      });
  }
  const manifest = JSON.stringify({
    kind: "nedia.platform-plugin",
    protocol: 1,
    sdk: 1,
    automation: 1,
    id: `platform.${platform}`,
    version,
    platformId: platform,
    displayName: {
      douyin: "抖音",
      kuaishou: "快手",
      xiaohongshu: "小红书",
      mock: "本地模拟平台",
    }[platform],
    entry: "entry.mjs",
    icon: "assets/icon.svg",
    capabilities:
      platform === "xiaohongshu" && !legacyXiaohongshu
        ? ["browser", "scripts", "network", "media"]
        : ["browser"],
    files: files.map(({ path, bytes }) => ({
      path,
      size: bytes.length,
      sha256: hash(bytes),
    })),
  });
  const signature = {
    keyId,
    value: sign(
      null,
      Buffer.from("nedia.platform-plugin/v1\n" + manifest),
      privateKey,
    ).toString("base64"),
  };
  // Optional plugins are built for manual installation, never preinstalled.
  const destination = platform === "mock" ? join(output, "optional") : output;
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, `platform.${platform}.nmp`),
    JSON.stringify({
      manifest,
      signature,
      files: files.map(({ path, bytes }) => ({
        path,
        data: bytes.toString("base64"),
      })),
    }),
  );
}
rmSync(work, { recursive: true, force: true });
process.stdout.write(
  `Built ${platforms.length} ${development ? "development" : "signed release"} platform plugins.\n`,
);
