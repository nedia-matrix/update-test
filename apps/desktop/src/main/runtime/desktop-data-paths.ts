import { app } from "electron";
import { configuredRuntimePaths, type RuntimePaths } from "./runtime-paths.js";

export function desktopRuntimePaths(): RuntimePaths {
  const configured = configuredRuntimePaths();
  if (configured) return configured;
  // Legacy standalone adapters (including isolated unit harnesses) receive an
  // already selected directory from their host. Both real entrypoints configure
  // paths before loading business services.
  const directory = app.getPath("userData");
  return {
    shell: "electron",
    environment: app.isPackaged ? "production" : "development",
    businessDirectory: directory,
    shellDirectory: directory,
  };
}
export const businessDataDirectory = () =>
  desktopRuntimePaths().businessDirectory;
export const shellDataDirectory = () => desktopRuntimePaths().shellDirectory;
