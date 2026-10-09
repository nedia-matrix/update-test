import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";
import {
  abortableWait,
  InteractionQueue,
  sampleTiming,
} from "./human-interaction.js";

export function retryAfterMilliseconds(
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** Shared by profile/session/content readers of one BrowserContext. */
export class RequestPacer {
  private queue = new InteractionQueue();
  private nextAllowedAt = 0;
  private cooldownUntil = 0;
  assertAllowed() {
    if (this.cooldownUntil > Date.now())
      throw new PlatformDataOperationError(
        "rate_limited",
        `platform_rate_limited(retry_after_ms=${this.cooldownUntil - Date.now()})`,
      );
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      signal.throwIfAborted();
      // A long server cooldown is returned to the caller instead of silently sleeping a task for hours.
      this.assertAllowed();
      await abortableWait(Math.max(0, this.nextAllowedAt - Date.now()), signal);
      signal.throwIfAborted();
      // An observed response on another page may start a cooldown while waiting.
      this.assertAllowed();
      try {
        return await operation();
      } finally {
        this.nextAllowedAt = Date.now() + sampleTiming("scroll");
      }
    });
  }
  rateLimited(retryAfterMs?: number) {
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      Date.now() + Math.max(1000, retryAfterMs ?? 30_000),
    );
  }
}
const pacers = new WeakMap<object, RequestPacer>();
const profiles = new Map<string, RequestPacer>();
export function bindProfileRequestPacer(
  context: object,
  profileDirectory: string,
) {
  let pacer = profiles.get(profileDirectory);
  if (!pacer) {
    pacer = new RequestPacer();
    profiles.set(profileDirectory, pacer);
  }
  pacers.set(context, pacer);
}
export function contextRequestPacer(context: object): RequestPacer {
  let pacer = pacers.get(context);
  if (!pacer) {
    pacer = new RequestPacer();
    pacers.set(context, pacer);
  }
  return pacer;
}
