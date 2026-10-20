import {
  PublishMonitorLifecycle,
  type ObservedHttpResponse,
  type PublishMonitorContext,
  type PublishResultEvent,
  type PublishResultMonitor,
} from "@nedia-matrix/platform-sdk";

const resultTimeoutMs = 10_000;
const pollIntervalMs = 100;
const maxResponseBytes = 100_000;

type PublishedIdentity = {
  contentId: string;
  contentUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function identityFrom(value: unknown): PublishedIdentity | null {
  if (!isRecord(value) || typeof value.postId !== "string") return null;
  return {
    contentId: value.postId,
    contentUrl:
      typeof value.postUrl === "string"
        ? value.postUrl
        : `http://127.0.0.1:4173/publications/${value.postId}`,
  };
}

function isPublishResponse(
  response: Pick<ObservedHttpResponse, "method" | "url">,
): boolean {
  return (
    response.method.toUpperCase() === "POST" &&
    /^http:\/\/127\.0\.0\.1:4173\/api\/publications(?:[?#].*)?$/.test(
      response.url,
    )
  );
}

function responseMessage(body: unknown): string | null {
  return isRecord(body) && typeof body.message === "string"
    ? body.message
    : null;
}

export function createMockPublishResultMonitor(
  context: PublishMonitorContext,
): PublishResultMonitor {
  if (context.contentForm === "longText") {
    throw new TypeError("Mock long-text observation is not implemented");
  }

  const { session, clock } = context;
  const listeners = new Set<(event: PublishResultEvent) => void>();
  const lifecycle = new PublishMonitorLifecycle();
  let watchRun = 0;
  let responseQueue = Promise.resolve();
  let deadline: number | null = null;
  let submissionObserved = false;
  let interrupting: Promise<void> | undefined;
  const reportedDiagnostics = new Set<string>();

  const reportOnce = (
    stage: "response" | "page",
    code: string,
    message: string,
  ): void => {
    const key = `${stage}:${code}`;
    if (reportedDiagnostics.has(key)) return;
    reportedDiagnostics.add(key);
    context.diagnostics.report({ stage, code, message });
  };

  const emit = (event: PublishResultEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const stop = (): void => {
    if (!lifecycle.complete()) return;
    watchRun += 1;
    unsubscribeRequests();
    unsubscribeResponses();
    unsubscribeClose();
  };
  const observeSubmissionRequest = (): void => {
    if (
      submissionObserved ||
      (lifecycle.state !== "armed" && lifecycle.state !== "verifying")
    )
      return;
    submissionObserved = true;
    emit({
      kind: "submission_attempted",
      source: "page_request",
      message: "已观察到模拟平台发布请求",
    });
  };

  const finish = (event: PublishResultEvent): void => {
    if (lifecycle.state === "completed") return;
    emit(event);
    stop();
  };

  const beginVerification = (message: string): void => {
    if (!lifecycle.beginVerification()) return;
    if (context.submissionMode === "automatic") {
      deadline = clock.now() + resultTimeoutMs;
    }
    emit({ kind: "verifying", message });
  };

  async function watchResult(run: number): Promise<void> {
    while (
      (lifecycle.state === "armed" || lifecycle.state === "verifying") &&
      run === watchRun
    ) {
      if (lifecycle.state === "armed") {
        try {
          if (await session.page.isTextVisible("发布成功")) {
            beginVerification("页面已显示发布成功");
          }
        } catch {
          reportOnce(
            "page",
            "success_indicator_read_failed",
            "无法读取本地模拟平台的发布成功提示",
          );
        }
      }

      if (deadline !== null && clock.now() >= deadline) {
        finish({
          kind: "uncertain",
          message: "未能在本地模拟平台确认新作品",
        });
        return;
      }
      await clock.sleep(pollIntervalMs);
    }
  }

  async function inspectResponse(
    response: ObservedHttpResponse,
    eligibleAtArrival: boolean,
  ): Promise<void> {
    if (!eligibleAtArrival || !isPublishResponse(response)) return;
    const text = await response.readText(maxResponseBytes);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    if (response.status >= 400) {
      finish({
        kind: "failed",
        message:
          responseMessage(body) ?? `本地模拟发布接口返回 ${response.status}`,
      });
      return;
    }
    const identity = isRecord(body) ? identityFrom(body.data) : null;
    if (identity) {
      finish({ kind: "published", ...identity });
      return;
    }
    if (isRecord(body) && body.success === true) {
      beginVerification("模拟平台已受理发布");
    }
  }

  const unsubscribeResponses = session.responses.subscribe((response) => {
    const eligibleAtArrival =
      lifecycle.state === "armed" || lifecycle.state === "verifying";
    responseQueue = responseQueue
      .then(() => inspectResponse(response, eligibleAtArrival))
      .catch(() => {
        reportOnce(
          "response",
          "publish_response_read_failed",
          "无法读取本地模拟发布响应，将继续等待明确的发布结果",
        );
      });
  });
  const unsubscribeRequests =
    session.requests?.subscribe((request) => {
      if (isPublishResponse(request)) observeSubmissionRequest();
    }) ?? (() => undefined);

  const interrupt = (
    reason: "page_closed" | "observation_interrupted" | "desktop_shutdown",
  ) => {
    interrupting ??= (async () => {
      unsubscribeRequests();
      unsubscribeResponses();
      unsubscribeClose();
      watchRun += 1;
      await responseQueue;
      if (lifecycle.state === "completed") return;
      finish(
        submissionObserved || lifecycle.state === "verifying"
          ? {
              kind: "uncertain",
              message: `${reason === "page_closed" ? "模拟发布窗口已关闭" : "模拟发布观察已中断"}，请核实平台结果`,
            }
          : { kind: "cancelled", message: "未观察到提交尝试，发布已取消" },
      );
    })();
    return interrupting;
  };

  const unsubscribeClose = session.page.subscribeClose(() => {
    void interrupt("page_closed");
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ready() {},
    arm() {
      if (!lifecycle.arm()) return;
      void watchResult(++watchRun);
    },
    submissionAttempted() {
      submissionObserved = true;
      if (context.submissionMode === "automatic") {
        deadline = clock.now() + resultTimeoutMs;
      }
    },
    interrupt,
    stop,
  };
}
