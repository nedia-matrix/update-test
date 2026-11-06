import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
await listen<{ channel: string; args: unknown[] }>(
  "sidecar-event",
  ({ payload }) => {
    for (const listener of listeners.get(payload.channel) ?? [])
      listener({}, ...payload.args);
  },
);
await listen<string>("sidecar-failed", ({ payload }) => {
  const warning = document.createElement("div");
  warning.textContent = `业务进程已停止：${payload}。请重新打开应用；不要重复提交发布。`;
  warning.setAttribute("role", "alert");
  document.body.prepend(warning);
});
await invoke("sidecar_ready");
export const ipcRenderer = {
  invoke: async (channel: string, ...args: unknown[]) => {
    // JSON converts undefined array entries to null; preserve optional IPC arguments.
    while (args.length && args.at(-1) === undefined) args.pop();
    try {
      return await invoke("desktop_invoke", { channel, args });
    } catch (error) {
      throw new Error(typeof error === "string" ? error : String(error));
    }
  },
  on(channel: string, listener: (...args: unknown[]) => void) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
  },
  removeListener(channel: string, listener: (...args: unknown[]) => void) {
    listeners.get(channel)?.delete(listener);
  },
};
