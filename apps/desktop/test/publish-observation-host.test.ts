import type {
  PublishResultEvent,
  PublishResultMonitor,
} from "@nedia-matrix/platform-sdk";
import { toPublishResultUpdate } from "@nedia-matrix/publishing";
import { describe, expect, it, vi } from "vitest";

import { PublishObservationManager } from "../src/main/publishing/observations/publish-observation-manager.js";

function fakeMonitor() {
  const listeners = new Set<(event: PublishResultEvent) => void>();
  const monitor: PublishResultMonitor = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready: vi.fn(async () => undefined),
    arm: vi.fn(),
    submissionAttempted: vi.fn(),
    interrupt: vi.fn(async () => {
      for (const listener of listeners) {
        listener({ kind: "cancelled", message: "closed" });
      }
    }),
    stop: vi.fn(),
  };
  return {
    monitor,
    emit: (event: PublishResultEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe("PublishObservationManager", () => {
  it("adds host identity without leaking it into the platform monitor", async () => {
    const onEvent = vi.fn(async () => undefined);
    const host = new PublishObservationManager(onEvent);
    const fake = fakeMonitor();
    const hosted = host.attach({
      publicationId: "publication-1",
      accountId: "account-1",
      platformId: "platform-1",
      monitor: fake.monitor,
    });

    await hosted.ready();
    hosted.arm();
    fake.emit({ kind: "verifying", message: "checking" });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());

    expect(fake.monitor.ready).toHaveBeenCalledOnce();
    expect(fake.monitor.arm).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        observationId: hosted.id,
        publicationId: "publication-1",
        accountId: "account-1",
        platformId: "platform-1",
        result: { kind: "verifying", message: "checking" },
      }),
    );
  });

  it("stops the previous observation for the same account", async () => {
    const host = new PublishObservationManager(vi.fn(async () => undefined));
    const first = fakeMonitor();
    const second = fakeMonitor();
    host.attach({
      publicationId: "publication-1",
      accountId: "a",
      platformId: "p",
      monitor: first.monitor,
    });
    host.attach({
      publicationId: "publication-2",
      accountId: "a",
      platformId: "p",
      monitor: second.monitor,
    });
    await vi.waitFor(() => expect(first.monitor.stop).toHaveBeenCalledOnce());
  });

  it("persists the monitor terminal result when its browser closes", async () => {
    const onEvent = vi.fn(async () => undefined);
    const host = new PublishObservationManager(onEvent);
    const fake = fakeMonitor();
    const hosted = host.attach({
      publicationId: "publication-1",
      accountId: "a",
      platformId: "p",
      monitor: fake.monitor,
    });
    hosted.arm();

    await host.stop("a");

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: "publication-1",
        result: expect.objectContaining({ kind: "cancelled" }),
      }),
    );
  });

  it("can dispose an armed observation without hiding a caller-owned error", async () => {
    const onEvent = vi.fn(async () => undefined);
    const host = new PublishObservationManager(onEvent);
    const fake = fakeMonitor();
    const hosted = host.attach({
      publicationId: "publication-1",
      accountId: "a",
      platformId: "p",
      monitor: fake.monitor,
    });
    hosted.arm();

    await hosted.stopSilently();

    expect(onEvent).not.toHaveBeenCalled();
    expect(fake.monitor.stop).toHaveBeenCalledOnce();
  });

  it("releases its publication lease after a terminal result is durable", async () => {
    const onFinished = vi.fn();
    const host = new PublishObservationManager(vi.fn(async () => undefined));
    const fake = fakeMonitor();
    const hosted = host.attach({
      publicationId: "publication-1",
      accountId: "a",
      platformId: "p",
      monitor: fake.monitor,
      onFinished,
    });
    hosted.arm();

    fake.emit({ kind: "failed", message: "rejected" });
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledOnce());

    expect(onFinished).toHaveBeenCalledWith({
      kind: "failed",
      message: "rejected",
    });
  });

  it("keeps the publication lease while terminal persistence is pending", async () => {
    let acknowledge = (): void => undefined;
    const persistence = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const onFinished = vi.fn();
    const host = new PublishObservationManager(() => persistence);
    const fake = fakeMonitor();
    host.attach({
      publicationId: "publication-1",
      accountId: "a",
      platformId: "p",
      monitor: fake.monitor,
      onFinished,
    });

    fake.emit({ kind: "cancelled", message: "closed" });
    await Promise.resolve();
    expect(onFinished).not.toHaveBeenCalled();

    acknowledge();
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
  });

  it("finishes diagnostics only after a terminal result is durable", async () => {
    let acknowledge = (): void => undefined;
    const persistence = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const finish = vi.fn();
    const report = vi.fn();
    const host = new PublishObservationManager(() => persistence);
    const fake = fakeMonitor();
    host.attach({
      publicationId: "publication-1",
      accountId: "a",
      platformId: "p",
      monitor: fake.monitor,
      diagnostics: {
        traceId: "trace-1",
        bind: vi.fn(),
        report,
        execution: vi.fn(),
        finish,
      },
    });

    fake.emit({ kind: "failed", message: "rejected" });
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();

    acknowledge();
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    expect(finish).toHaveBeenCalledWith({ outcome: "failed" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "monitor.result_persisted" }),
    );
  });

  it("maps platform results to renderer updates at the host boundary", () => {
    expect(
      toPublishResultUpdate({
        eventId: "event-1",
        observationId: "observation-1",
        publicationId: "publication-1",
        accountId: "account-1",
        platformId: "douyin",
        sequence: 1,
        result: {
          kind: "published",
          contentId: "work-1",
          contentUrl: "https://example.com/work-1",
        },
      }),
    ).toEqual({
      observationId: "observation-1",
      publicationId: "publication-1",
      accountId: "account-1",
      status: "published",
      message: "发布成功",
      platformContentId: "work-1",
      platformContentUrl: "https://example.com/work-1",
    });
  });
});
