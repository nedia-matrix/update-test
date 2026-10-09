import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { PlatformDataOperationError } from "@nedia-matrix/platform-sdk";
import {
  abortableWait,
  curvePoints,
  HumanInteractionSession,
  jitterPoint,
  sampleTiming,
  accountInteractionQueue,
} from "../src/human-interaction.js";
import { RequestPacer, retryAfterMilliseconds } from "../src/request-pacing.js";

describe("human input lifecycle and geometry", () => {
  it("keeps jitter inside tiny targets and curves end exactly at the chosen point", () => {
    const box = { x: 20, y: 40, width: 2, height: 3 };
    for (const random of [() => 0, () => 0.99]) {
      const point = jitterPoint(box, random);
      expect(point.x).toBeGreaterThan(box.x);
      expect(point.x).toBeLessThan(box.x + box.width);
      expect(point.y).toBeGreaterThan(box.y);
      expect(point.y).toBeLessThan(box.y + box.height);
      const curve = curvePoints({ x: 0, y: 0 }, point, random);
      expect(curve.at(-1)).toEqual(point);
      expect(curve.length).toBeGreaterThanOrEqual(10);
      expect(
        curve
          .slice(0, -1)
          .some((p) => Math.abs(p.x * point.y - p.y * point.x) > 0.01),
      ).toBe(true);
    }
    expect(sampleTiming("key", () => 0)).toBeGreaterThanOrEqual(30);
    expect(sampleTiming("key", () => 0)).toBeLessThanOrEqual(400);
  });
  it("interrupts a pending delay without advancing time", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = expect(
        abortableWait(4000, controller.signal),
      ).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("serializes pages of one account and revokes queued work before it starts", async () => {
    const context = {};
    const queue = accountInteractionQueue(context);
    expect(accountInteractionQueue(context)).toBe(queue);
    const first = new HumanInteractionSession(
      { isClosed: () => false } as Page,
      { queue },
    );
    const second = new HumanInteractionSession(
      { isClosed: () => false } as Page,
      { queue },
    );
    let release!: () => void;
    const started = vi.fn();
    const a = first.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const b = expect(
      second.run(async () => {
        started();
      }),
    ).rejects.toThrow("取消");
    second.stop();
    release();
    await a;
    await b;
    expect(started).not.toHaveBeenCalled();
  });
});

describe("account request pacing", () => {
  it("rechecks a cooldown that starts during the inter-request wait", async () => {
    vi.useFakeTimers();
    try {
      const pacer = new RequestPacer();
      const signal = new AbortController().signal;
      const physical = vi.fn(async () => undefined);
      const first = pacer.run(signal, physical);
      await vi.advanceTimersByTimeAsync(1);
      await first;
      const second = expect(pacer.run(signal, physical)).rejects.toMatchObject({
        name: "PlatformDataOperationError",
        code: "rate_limited",
      });
      await vi.advanceTimersByTimeAsync(10);
      pacer.rateLimited(30_000);
      await vi.advanceTimersByTimeAsync(2100);
      await second;
      expect(physical).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      const resumed = pacer.run(signal, physical);
      await vi.runAllTimersAsync();
      await resumed;
      expect(physical).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("honors Retry-After and blocks new physical requests during cooldown", async () => {
    expect(retryAfterMilliseconds("2")).toBe(2000);
    expect(retryAfterMilliseconds("invalid")).toBeUndefined();
    const pacer = new RequestPacer();
    const physical = vi.fn(async () => undefined);
    pacer.rateLimited(5000);
    await expect(
      pacer.run(new AbortController().signal, physical),
    ).rejects.toBeInstanceOf(PlatformDataOperationError);
    expect(physical).not.toHaveBeenCalled();
  });
});
