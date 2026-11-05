import { join } from "node:path";
import type { PluginEnvironment } from "../../desktop/src/main/plugins/plugin-environment.js";

declare const __NEDIA_TAURI_SHARED_PLUGIN_KEYS__: Record<string, string>;
declare const __NEDIA_TAURI_PLUGIN_KEYS__: Record<string, string> | null;
export function tauriPluginEnvironment(
  root: string,
  sharedUserData = false,
): PluginEnvironment {
  const keys = sharedUserData
    ? typeof __NEDIA_TAURI_SHARED_PLUGIN_KEYS__ === "undefined"
      ? {}
      : __NEDIA_TAURI_SHARED_PLUGIN_KEYS__
    : typeof __NEDIA_TAURI_PLUGIN_KEYS__ === "undefined"
      ? null
      : __NEDIA_TAURI_PLUGIN_KEYS__;
  return keys === null
    ? {
        trust: "development",
        bundledDirectory: join(root, ".plugins-development"),
      }
    : {
        trust: "release",
        bundledDirectory: join(root, "plugins"),
        publicKeys: keys,
      };
}
