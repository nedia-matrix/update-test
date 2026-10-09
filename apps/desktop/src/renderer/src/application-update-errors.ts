/** Electron IPC serializes Error.message; implementation details do not belong in update feedback. */
export function updateErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");
  if (
    /\b(?:AbortError|TimeoutError)\b|operation was aborted|fetch failed/i.test(
      message,
    )
  )
    return "连接更新源超时或中断，请检查网络后重试。";
  return message || fallback;
}
