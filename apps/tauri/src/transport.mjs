import { createInterface } from "node:readline";

// stdout is a private JSON-lines pipe to the Rust parent; diagnostics use stderr.
let connected = true;
export const send = (message) => {
  if (!connected) return false;
  const line = `${JSON.stringify(message)}\n`;
  try {
    process.stdout.write(line);
    return true;
  } catch {
    disconnect();
    return false;
  }
};
// The Rust parent must receive intentional exit before the sidecar disappears.
export function exitAfterFlush(code) {
  if (!connected) process.exit(code);
  try {
    process.stdout.write(`${JSON.stringify({ type: "exit" })}\n`, () =>
      process.exit(code),
    );
  } catch {
    process.exit(code);
  }
}
process.stdout.on("error", disconnect);
const handlers = new Map();
const nativeRequests = new Map();
let sequence = 0;
let ready = false;
let stopping = false;
let quit;
export const ipcMain = {
  handle(channel, handler) {
    if (handlers.has(channel)) throw new Error(`Duplicate channel: ${channel}`);
    handlers.set(channel, handler);
  },
};
export const sender = {
  isDestroyed: () => stopping,
  send: (channel, ...args) => send({ type: "event", channel, args }),
};
export function native(method, options = {}) {
  if (!connected) return Promise.reject(new Error("桌面壳连接已断开"));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    nativeRequests.set(id, { resolve, reject });
    send({ type: "native", id, method, options });
  });
}
export function serve(onQuit) {
  quit = onQuit;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void dispatch(line).catch((error) =>
      console.error("Sidecar protocol error", error),
    );
  });
  lines.on("close", disconnect);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
function rejectNative(message) {
  for (const pending of nativeRequests.values())
    pending.reject(new Error(message));
  nativeRequests.clear();
}
function disconnect() {
  if (!connected) return;
  connected = false;
  rejectNative("桌面壳连接已断开");
  stop();
}
function stop() {
  if (!stopping) {
    stopping = true;
    rejectNative("应用正在退出");
  }
  // A deliberate repeated quit may retry a failed cleanup; the runtime
  // prevents concurrent attempts and retains ownership while one is pending.
  quit?.();
}
async function dispatch(line) {
  const request = JSON.parse(line);
  if (request.type === "native-result") {
    const pending = nativeRequests.get(request.id);
    if (!pending) return;
    nativeRequests.delete(request.id);
    if (request.error) pending.reject(new Error(request.error));
    else pending.resolve(request.result);
    return;
  }
  if (request.type === "shutdown") return stop();
  if (request.type !== "invoke" || !Number.isSafeInteger(request.id)) return;
  try {
    if (!ready || stopping) throw new Error("业务进程尚未就绪或正在退出");
    const handler = handlers.get(request.channel);
    if (!handler)
      throw new Error(`Unsupported desktop channel: ${request.channel}`);
    const result = await handler({ sender }, ...(request.args ?? []));
    send({ type: "result", id: request.id, result: result ?? null });
  } catch (error) {
    send({
      type: "result",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
export function markReady() {
  ready = true;
  send({ type: "ready", channels: [...handlers.keys()] });
}
