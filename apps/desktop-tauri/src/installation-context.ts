import type { InstallContext } from "@nedia-matrix/desktop-runtime/updates/update-installation";

declare const __NEDIA_UPDATE_DISTRIBUTION__: string;
export function tauriInstallationContext(): Omit<
  InstallContext,
  "userData" | "currentVersion"
> {
  // Both Windows payloads share a sidecar; only the portable launcher sets these paths.
  const portable =
    process.platform === "win32" &&
    (process.env.PORTABLE_EXECUTABLE_FILE ||
      process.env.PORTABLE_EXECUTABLE_DIR);
  return {
    packaged: process.env.NEDIA_TAURI_PACKAGED === "1",
    platform: process.platform,
    arch: process.arch,
    distribution: portable
      ? "portable"
      : typeof __NEDIA_UPDATE_DISTRIBUTION__ === "string"
        ? __NEDIA_UPDATE_DISTRIBUTION__
        : "unsupported",
    executable: process.env.NEDIA_TAURI_EXECUTABLE!,
    parentPid: Number(process.env.NEDIA_TAURI_PARENT_PID),
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
    portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
    resources: process.env.NEDIA_TAURI_RUNTIME!,
  };
}
