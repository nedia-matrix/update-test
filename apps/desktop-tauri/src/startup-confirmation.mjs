// This private bridge channel is sent only after renderer imports have completed.
export const rendererReadyChannel = "nedia:tauri-renderer-ready";

export function registerRendererStartup(ipc, runtime, confirm) {
  ipc.handle(rendererReadyChannel, async () => {
    runtime.assertAcceptingCommands();
    await confirm();
    return null;
  });
}

export async function loadAndConfirmRenderer(load, confirm) {
  await load();
  await confirm();
}
