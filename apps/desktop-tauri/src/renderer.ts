import { createDesktopApi } from "@nedia-matrix/desktop-client/api-client";
import { ipcRenderer } from "./renderer-platform.js";
import { invoke } from "@tauri-apps/api/core";
import {
  loadAndConfirmRenderer,
  rendererReadyChannel,
} from "./startup-confirmation.mjs";
try {
  await loadAndConfirmRenderer(
    async () => {
      Object.defineProperty(window, "matrix", {
        value: createDesktopApi(ipcRenderer),
      });
      await import("@nedia-matrix/desktop-client/renderer");
    },
    () => invoke("desktop_invoke", { channel: rendererReadyChannel, args: [] }),
  );
} catch (error) {
  const warning = document.createElement("p");
  warning.setAttribute("role", "alert");
  warning.textContent = `应用启动失败：${error instanceof Error ? error.message : String(error)}。请退出后重新打开；不要重复发布。`;
  document.querySelector("#app")?.replaceChildren(warning);
}
