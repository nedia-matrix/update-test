import { defineConfig } from "electron-vite";
import {
  configuredPublicKeys,
  validateReleasePublicKeys,
} from "../../scripts/publish/update-keys.mjs";
const updateKeys = validateReleasePublicKeys(configuredPublicKeys(), {
  required: process.env.NEDIA_REQUIRE_UPDATE_KEYS === "1",
});
const distribution =
  process.env.NEDIA_UPDATE_DISTRIBUTION ??
  (process.platform === "darwin" ? "app-zip" : "unsupported");
if (!["app-zip", "portable", "nsis", "unsupported"].includes(distribution))
  throw new Error("Invalid NEDIA_UPDATE_DISTRIBUTION");

const updateSourceDefine = {
  __NEDIA_DEFAULT_UPDATE_SOURCE_URL__: JSON.stringify(
    process.env.NEDIA_DEFAULT_UPDATE_SOURCE_URL ??
      "https://github.com/nedia-matrix/desktop",
  ),
};

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          "@nedia-matrix/desktop-runtime",
          "@nedia-matrix/desktop-contracts",
          "@nedia-matrix/desktop-client",
        ],
      },
      rollupOptions: { external: ["electron", "playwright-core"] },
    },
    define: {
      ...updateSourceDefine,
      __NEDIA_UPDATE_PUBLIC_KEYS__: JSON.stringify(updateKeys),
      __NEDIA_UPDATE_DISTRIBUTION__: JSON.stringify(distribution),
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    define: updateSourceDefine,
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "preact",
    },
    server: {
      port: 8888,
      strictPort: true,
    },
  },
});
