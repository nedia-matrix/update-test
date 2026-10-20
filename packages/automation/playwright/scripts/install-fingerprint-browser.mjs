import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintBrowserVersion,
  installFingerprintBrowser,
  readFingerprintInstallation,
  recoverFingerprintInstallation,
  verifyFingerprintBrowser,
} from "../dist/index.js";

const cacheRoot =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Caches")
    : process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? tmpdir())
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
const root = join(
  cacheRoot,
  "nedia-matrix",
  "browsers",
  fingerprintBrowserVersion,
);
const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  await recoverFingerprintInstallation(root);
  let executable = await readFingerprintInstallation(root);
  if (executable) {
    console.log("Verifying installed native fingerprint capability…");
    await verifyFingerprintBrowser(executable, controller.signal);
    controller.signal.throwIfAborted();
  } else {
    let lastPhase;
    executable = await installFingerprintBrowser({
      root,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase !== lastPhase) {
          console.log(
            `${progress.phase}: fingerprint Chromium ${fingerprintBrowserVersion}`,
          );
          lastPhase = progress.phase;
        }
      },
    });
  }
  console.log(`Verified: ${executable}`);
  console.log(
    process.platform === "win32"
      ? `$env:NEDIA_FINGERPRINT_BROWSER_PATH = '${executable.replaceAll("'", "''")}'`
      : `export NEDIA_FINGERPRINT_BROWSER_PATH='${executable.replaceAll("'", "'\\''")}'`,
  );
} catch (error) {
  if (controller.signal.aborted) {
    console.error("Installation cancelled after cleanup.");
    process.exitCode = 130;
  } else throw error;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
