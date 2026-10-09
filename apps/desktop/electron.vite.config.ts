import { defineConfig } from "electron-vite";
import { createPublicKey } from "node:crypto";
import { configuredPublicKeys } from "../../scripts/update-keys.mjs";
const updateKeys = configuredPublicKeys();
if (
  process.env.NEDIA_REQUIRE_UPDATE_KEYS === "1" &&
  Object.keys(updateKeys ?? {}).length === 0
) {
  throw new Error("签名发布构建必须配置 NEDIA_UPDATE_PUBLIC_KEYS");
}
if (
  !updateKeys ||
  Array.isArray(updateKeys) ||
  typeof updateKeys !== "object"
) {
  throw new Error(
    "NEDIA_UPDATE_PUBLIC_KEYS must be a JSON object of key IDs and PEM public keys",
  );
}
for (const [id, pem] of Object.entries(updateKeys)) {
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
    typeof pem !== "string" ||
    !pem.includes("-----BEGIN PUBLIC KEY-----") ||
    pem.includes("PRIVATE KEY") ||
    createPublicKey(pem).asymmetricKeyType !== "ed25519"
  ) {
    throw new Error(
      "NEDIA_UPDATE_PUBLIC_KEYS contains an invalid Ed25519 public key",
    );
  }
}
const distribution =
  process.env.NEDIA_UPDATE_DISTRIBUTION ??
  (process.platform === "darwin" ? "app-zip" : "unsupported");
if (!["app-zip", "portable", "nsis", "unsupported"].includes(distribution))
  throw new Error("Invalid NEDIA_UPDATE_DISTRIBUTION");

export default defineConfig({
  main: {
    define: {
      __NEDIA_UPDATE_PUBLIC_KEYS__: JSON.stringify(updateKeys),
      __NEDIA_UPDATE_DISTRIBUTION__: JSON.stringify(distribution),
    },
    build: {
      rollupOptions: {
        external: ["electron", "playwright", "playwright-core"],
      },
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
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "preact",
    },
    server: {
      port: 3000,
      strictPort: true,
    },
  },
});
