import {
  configuredPublicKeys,
  validateReleasePublicKeys,
} from "../../scripts/publish/update-keys.mjs";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { syncReleaseVersion } from "../../scripts/publish/release-config.mjs";
const here = import.meta.dirname;
const root = resolve(here, "../..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const { version: appVersion } = syncReleaseVersion(root);
const releaseDefines = {
  __NEDIA_TAURI_BUILD__: "true",
  __NEDIA_APP_VERSION__: JSON.stringify(appVersion),
  __NEDIA_DEFAULT_UPDATE_SOURCE_URL__: JSON.stringify(
    process.env.NEDIA_DEFAULT_UPDATE_SOURCE_URL ??
      "https://github.com/nedia-matrix/desktop",
  ),
  __NEDIA_UPDATE_PUBLIC_KEYS__: JSON.stringify(configuredPublicKeys()),
  __NEDIA_UPDATE_DISTRIBUTION__: JSON.stringify(
    process.platform === "darwin" ? "app-zip" : "nsis",
  ),
};
const trust = process.env.NEDIA_TAURI_PLUGIN_TRUST ?? "development";
if (!["development", "release"].includes(trust))
  throw new Error("Invalid NEDIA_TAURI_PLUGIN_TRUST");
const sharedKeys = validateReleasePublicKeys(configuredPublicKeys());
const releaseKeys =
  trust === "release"
    ? validateReleasePublicKeys(configuredPublicKeys(), { required: true })
    : null;
const pluginDirectory = resolve(
  process.env.NEDIA_TAURI_PLUGIN_DIRECTORY ??
    join(desktop, "resources/plugins"),
);
if (trust === "release") {
  execFileSync(
    process.execPath,
    [
      join(root, "scripts/package/verify-platform-plugins.mts"),
      pluginDirectory,
    ],
    { stdio: "inherit" },
  );
}
const runtime = resolve(
  process.env.NEDIA_TAURI_RUNTIME_OUTPUT ?? join(here, "runtime"),
);
mkdirSync(runtime, { recursive: true });
execFileSync("pnpm", ["desktop:build-dependencies"], {
  cwd: root,
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (trust === "development")
  execFileSync(
    process.execPath,
    [join(root, "scripts/package/build-platform-plugins.mjs"), "--development"],
    { cwd: root, stdio: "inherit" },
  );
execFileSync(
  process.execPath,
  [join(root, "scripts/package/build-runtime-lock.mjs")],
  { stdio: "inherit" },
);
const aliases = [
  { find: /^electron$/, replacement: join(here, "src/node-platform.ts") },
  ...[
    "electron-main-window",
    "application-tray",
    "application-menu",
    "electron-automation-notices",
  ].map((name) => ({
    find: new RegExp(`.*\/${name}\\.js$`),
    replacement: join(here, "src/shell.ts"),
  })),
];
await build({
  configFile: false,
  root: here,
  resolve: { alias: aliases },
  define: {
    ...releaseDefines,
    __NEDIA_TAURI_PLUGIN_KEYS__: JSON.stringify(releaseKeys),
    __NEDIA_TAURI_SHARED_PLUGIN_KEYS__: JSON.stringify(sharedKeys),
  },
  build: {
    target: "node24",
    outDir: runtime,
    emptyOutDir: true,
    minify: false,
    ssr: join(here, "src/sidecar.ts"),
    rollupOptions: {
      external: ["playwright-core"],
      output: { entryFileNames: "sidecar.mjs", inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: [/^@nedia-matrix\//] },
});
cpSync(join(desktop, "resources/native"), join(runtime, "native"), {
  recursive: true,
});
await build({
  configFile: false,
  root: here,
  base: "./",
  define: releaseDefines,
  resolve: {
    alias: [
      {
        find: /^electron$/,
        replacement: join(here, "src/renderer-platform.ts"),
      },
    ],
  },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    target: "es2022",
    outDir: process.env.NEDIA_TAURI_FRONTEND_OUTPUT ?? "dist",
    emptyOutDir: true,
  },
});
// Debug GUI shares official userData and must never install development packages there.
if (trust === "development") {
  const bundled = join(runtime, "plugins");
  mkdirSync(bundled, { recursive: true });
  for (const id of ["douyin", "kuaishou", "xiaohongshu"]) {
    const file = join(desktop, "resources/plugins", `platform.${id}.nmp`);
    if (existsSync(file)) cpSync(file, join(bundled, `platform.${id}.nmp`));
  }
}
if (trust === "release") {
  const bundled = join(runtime, "plugins");
  mkdirSync(bundled, { recursive: true });
  for (const id of ["douyin", "kuaishou", "xiaohongshu"]) {
    cpSync(
      join(pluginDirectory, `platform.${id}.nmp`),
      join(bundled, `platform.${id}.nmp`),
    );
  }
} else {
  cpSync(
    join(desktop, ".plugins-development"),
    join(runtime, ".plugins-development"),
    { recursive: true },
  );
}
// Bundle playwright-core unchanged: its driver assets must stay next to its entry.
const playwrightRequire = createRequire(
  join(root, "packages/automation/playwright/package.json"),
);
cpSync(
  dirname(playwrightRequire.resolve("playwright-core/package.json")),
  join(runtime, "node_modules/playwright-core"),
  { recursive: true },
);
writeFileSync(
  join(runtime, "package.json"),
  JSON.stringify({ type: "module", private: true }),
);
const version = "24.18.0";
const platform = process.platform;
const archiveName = `node-v${version}-${platform === "win32" ? "win" : platform}-${process.arch}`;
const cache = join(root, ".local/tauri-node");
const binary = platform === "win32" ? "node.exe" : "bin/node";
const cachedNode = join(cache, archiveName, binary);
if (!existsSync(cachedNode)) {
  mkdirSync(cache, { recursive: true });
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const archive = join(cache, `${archiveName}.${extension}`);
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "2",
      `https://nodejs.org/dist/v${version}/${archiveName}.${extension}`,
      "-o",
      archive,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
      "-o",
      join(cache, "SHASUMS256.txt"),
    ],
    { stdio: "inherit" },
  );
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  const checksum = readFileSync(join(cache, "SHASUMS256.txt"), "utf8")
    .split("\n")
    .find((line) => line.endsWith(`  ${archiveName}.${extension}`))
    ?.split(" ")[0];
  if (!checksum || digest !== checksum)
    throw new Error("Node archive checksum mismatch");
  if (platform === "win32")
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archive,
        "-DestinationPath",
        cache,
      ],
      { stdio: "inherit" },
    );
  else execFileSync("tar", ["-xzf", archive, "-C", cache]);
}
cpSync(cachedNode, join(runtime, platform === "win32" ? "node.exe" : "node"));
cpSync(join(cache, archiveName, "LICENSE"), join(runtime, "NODE-LICENSE"));
console.log(
  `Tauri assets ready (${appVersion}; ${trust} plugin trust; official userData shared by desktop shells).`,
);
if (trust === "release") {
  const helper = join(root, ".local/tauri-update-helper");
  const environment = {
    ...process.env,
    NEDIA_UPDATE_HELPER_OUTPUT: helper,
  };
  delete environment.NEDIA_UPDATE_PRIVATE_KEY;
  delete environment.NEDIA_UPDATE_PRIVATE_KEY_FILE;
  execFileSync(
    process.execPath,
    [
      join(root, "scripts/package/build-update-helper.mjs"),
      platform === "darwin" ? "mac" : "win",
    ],
    { env: environment, stdio: "inherit" },
  );
  cpSync(
    platform === "darwin" ? join(helper, process.arch) : helper,
    join(runtime, "update-helper"),
    { recursive: true },
  );
}
