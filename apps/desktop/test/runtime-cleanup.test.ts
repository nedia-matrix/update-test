import type { PlatformAccountSnapshot } from "@nedia-matrix/account-management";
import { describe, expect, it, vi } from "vitest";

import { cleanupClosedBrowserSession } from "../src/main/accounts/application/account-resource-cleanup.js";
import {
  shutdownDesktopRuntime,
  waitForShutdown,
} from "../src/main/bootstrap/runtime-cleanup.js";

const account = {
  id: "account-1",
  platformId: "douyin",
  profileId: "matrix-douyin-account-1",
} as PlatformAccountSnapshot;

describe("desktop runtime cleanup", () => {
  it("stops observations and releases media when a BrowserContext closes", () => {
    const publishObservations = { stop: vi.fn() };
    const mediaSelections = { removeForAccount: vi.fn() };

    cleanupClosedBrowserSession(account.id, {
      publishObservations,
      mediaSelections,
    });

    expect(publishObservations.stop).toHaveBeenCalledWith(account.id);
    expect(mediaSelections.removeForAccount).toHaveBeenCalledWith(account.id);
  });

  it("stops observations, closes sessions, and flushes diagnostics on exit", async () => {
    const publishObservations = { stopAll: vi.fn() };
    const mediaSelections = { clear: vi.fn() };
    const browserSessions = { closeAll: vi.fn(async () => undefined) };
    const diagnostics = {
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    await shutdownDesktopRuntime({
      browserSessions,
      diagnostics,
      mediaSelections,
      publishObservations,
    });

    expect(publishObservations.stopAll).toHaveBeenCalledOnce();
    expect(mediaSelections.clear).toHaveBeenCalledOnce();
    expect(browserSessions.closeAll).toHaveBeenCalledOnce();
    expect(diagnostics.flush).toHaveBeenCalledOnce();
    expect(diagnostics.close).toHaveBeenCalledOnce();
  });

  it("reports a completed shutdown without leaving a timeout behind", async () => {
    vi.useFakeTimers();
    try {
      await expect(waitForShutdown(Promise.resolve(), 5_000)).resolves.toBe(
        "completed",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting when shutdown exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const waiting = waitForShutdown(new Promise<void>(() => {}), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(waiting).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });
});
