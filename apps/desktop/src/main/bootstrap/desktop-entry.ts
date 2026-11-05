import { runtimeCompatibility } from "../runtime/runtime-support.js";
import { app } from "electron";
import { resolveRuntimePaths } from "../runtime/runtime-paths.js";

// Diagnostic startup deliberately does not import the business bootstrap.
if (process.argv.includes("--runtime-paths-report")) {
  try {
    const paths = resolveRuntimePaths({
      shell: "electron",
      environment: app.isPackaged ? "production" : "development",
      legacyDirectory: app.getPath("userData"),
      testRoot: process.env.NEDIA_COEXISTENCE_TEST_ROOT,
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        appName: app.getName(),
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
        portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
        appData: app.getPath("appData"),
        legacyUserData: app.getPath("userData"),
        ...paths,
        compatibility: runtimeCompatibility,
      })}\n`,
      () => app.exit(0),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
} else {
  await import("./start-desktop.js");
}
