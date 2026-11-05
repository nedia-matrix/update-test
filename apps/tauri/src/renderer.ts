import { invoke } from "@tauri-apps/api/core";
import {
  loadAndConfirmRenderer,
  rendererReadyChannel,
} from "./startup-confirmation.mjs";
try {
  await loadAndConfirmRenderer(
    async () => {
      await import("../../desktop/src/preload/index.ts");
      await import("../../desktop/src/renderer/src/index.tsx");
    },
    () => invoke("desktop_invoke", { channel: rendererReadyChannel, args: [] }),
  );
} catch (error) {
  const warning = document.createElement("p");
  warning.setAttribute("role", "alert");
  warning.textContent = `应用启动失败：${error instanceof Error ? error.message : String(error)}。请退出后重新打开；不要重复发布。`;
  document.querySelector("#app")?.replaceChildren(warning);
}
