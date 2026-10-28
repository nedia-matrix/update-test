import type {
  ScheduledTask,
  SyncTaskType,
  TaskQuery,
  TaskQueryResult,
  TaskState,
  TaskUseCases,
  TaskSummary,
  TaskSettings,
  TaskClearScope,
  ClearTaskHistoryRequest,
} from "../../bridge/tasks.js";
import { syncMinIntervalMs, taskGroups } from "../../bridge/tasks.js";
import {
  TaskStore,
  type TaskRecord,
  publicTask,
  occupiedStates,
  terminalStates,
  isTerminalTask,
} from "./task-store.js";

export class TaskExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs = 0,
    readonly resourcesClosed = true,
  ) {
    super(message);
  }
}
export interface TaskOutcome {
  state: TaskState;
  result?: unknown;
  error?: ScheduledTask["error"];
}
export interface TaskExecutionContext {
  update(
    patch: Partial<
      Pick<
        TaskRecord,
        | "phase"
        | "progress"
        | "publicationId"
        | "businessStarted"
        | "input"
        | "result"
        | "retainedItems"
      >
    >,
  ): void;
}
export interface SchedulerDependencies {
  account(accountId: string): { id: string; platformId: string };
  canStart(accountId: string): boolean;
  execute(
    task: TaskRecord,
    context: TaskExecutionContext,
  ): Promise<TaskOutcome>;
  reconcile(task: TaskRecord, recovering: boolean): TaskOutcome | undefined;
  changed?(): void;
  onError?(error: unknown): void;
  now?(): number;
  canPrunePublication?(task: TaskRecord): boolean;
}

/** A single Desktop process owns dispatch. Claim/cancel/rule watermarks use SQLite transactions. */
export class TaskScheduler implements TaskUseCases {
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private ticking = false;
  private readonly executions = new Map<string, Promise<void>>();
  private paused = false;
  private readonly listeners = new Set<() => void>();
  private fatal = false;
  private now: () => number;
  private nextCleanupAt = 0;
  private cleanupCursor = 0;
  private cleanupError?: string;
  constructor(
    readonly store: TaskStore,
    private readonly deps: SchedulerDependencies,
  ) {
    this.now = deps.now ?? Date.now;
  }
  start(): void {
    if (this.started) return;
    this.recover();
    this.started = true;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.tick();
  }
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    // Queue waiters are not commands that must execute before shutdown.
    this.notify();
    await Promise.allSettled([...this.executions.values()]);
  }
  pauseDispatch(): () => void {
    this.paused = true;
    return () => {
      this.paused = false;
      this.wake();
    };
  }
  isBusy(accountId: string): boolean {
    return this.store
      .list(true)
      .some(
        (t) => t.accountId === accountId && occupiedStates.includes(t.state),
      );
  }
  hasOccupied(): boolean {
    return this.store.list(true).some((t) => occupiedStates.includes(t.state));
  }
  get(id: string): ScheduledTask | null {
    const t = this.store.get(id);
    return t
      ? { ...this.visible(t), attempts: this.store.attempts(t.id) }
      : null;
  }
  byRequest(requestId: string): ScheduledTask | null {
    const task = this.store.byRequest(requestId);
    return task ? this.visible(task) : null;
  }
  query(request: TaskQuery = {}): TaskQueryResult {
    if (
      !request ||
      typeof request !== "object" ||
      (request.limit !== undefined &&
        (!Number.isSafeInteger(request.limit) ||
          request.limit < 1 ||
          request.limit > 100)) ||
      (request.offset !== undefined &&
        (!Number.isSafeInteger(request.offset) || request.offset < 0))
    )
      throw new TypeError("无效的任务查询");
    if (
      request.type !== undefined &&
      ![
        "account_profile_sync",
        "platform_content_sync",
        "publication",
      ].includes(request.type)
    )
      throw new TypeError("无效的任务类型");
    if (
      request.state !== undefined &&
      ![...occupiedStates, ...terminalStates, "queued", "retry_wait"].includes(
        request.state,
      )
    )
      throw new TypeError("无效的任务状态");
    if (
      request.group !== undefined &&
      !Object.hasOwn(taskGroups, request.group)
    )
      throw new TypeError("无效的任务分组");
    this.assertHistoryScope(request);
    const result = this.store.query(request);
    const active = this.store.list(true);
    return {
      ...result,
      clearable: this.clearableHistory(request),
      ...(this.fatal
        ? {
            schedulerError:
              "调度因状态保存或恢复故障暂停，请重启应用恢复；当前占用不会被超时抢占",
          }
        : {}),
      ...(!this.fatal && this.cleanupError
        ? { schedulerError: this.cleanupError }
        : {}),
      items: result.items.map((t) => this.visible(t, active)),
      occupied: active.filter((t) => occupiedStates.includes(t.state)).length,
      awaitingConfirmation: active.filter(
        (t) => t.state === "awaiting_confirmation",
      ).length,
      maxParallel: this.store.maxParallel(),
    };
  }
  private assertHistoryScope(scope: TaskClearScope): void {
    if (
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      ["type", "accountId", "platformId"].some((key) => {
        const value = scope[key as keyof TaskClearScope];
        return (
          value !== undefined && (typeof value !== "string" || !value.trim())
        );
      }) ||
      (scope.type !== undefined &&
        ![
          "account_profile_sync",
          "platform_content_sync",
          "publication",
        ].includes(scope.type))
    )
      throw new TypeError("无效的任务记录范围");
  }
  private canClearHistory(task: TaskRecord): boolean {
    return (
      task.endedAt !== null &&
      !this.executions.has(task.id) &&
      (task.type !== "publication" ||
        this.deps.canPrunePublication?.(task) === true)
    );
  }
  private clearableHistory(scope: TaskClearScope): {
    completed: number;
    failed: number;
  } {
    const counts = { completed: 0, failed: 0 };
    for (const task of this.store.historyCandidates(scope))
      if (this.canClearHistory(task))
        counts[task.state as "completed" | "failed"]++;
    return counts;
  }
  clearHistory(request: ClearTaskHistoryRequest): { removed: number } {
    this.assertAccepting();
    this.assertHistoryScope(request);
    if (
      !["completed", "failed"].includes(request.state) ||
      Object.keys(request).some(
        (key) => !["state", "type", "accountId", "platformId"].includes(key),
      )
    )
      throw new TypeError("只能清除已完成或失败记录");
    const removed = this.store.clearHistory(request, request.state, (task) =>
      this.canClearHistory(task),
    );
    if (removed) this.notify();
    return { removed };
  }
  settings(): TaskSettings {
    return this.store.settings();
  }
  setRetentionDays(value: number): TaskSettings {
    this.assertAccepting();
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000)
    )
      throw new TypeError("记录保留天数必须为正整数且在有效范围内");
    this.store.setRetentionDays(value);
    this.nextCleanupAt = 0;
    this.cleanupCursor = 0;
    this.notify();
    this.wake();
    return this.settings();
  }
  acknowledgeAttention(items: { id: string; version: string }[]): void {
    if (
      !Array.isArray(items) ||
      items.length > 100 ||
      items.some(
        (i) => !i || typeof i.id !== "string" || typeof i.version !== "string",
      )
    )
      throw new TypeError("无效的异常查看记录");
    this.store.acknowledgeAttention(items);
    this.notify();
  }
  summary(): TaskSummary {
    const records = this.store.list(true);
    const active = records.map((t) => this.visible(t, records));
    const occupied = active.filter((t) => occupiedStates.includes(t.state));
    const priority = (t: ScheduledTask) =>
      t.state === "awaiting_confirmation"
        ? 0
        : t.state === "finalizing" && t.error
          ? 1
          : 2;
    occupied.sort(
      (a, b) => priority(a) - priority(b) || a.sequence - b.sequence,
    );
    const queued = active.filter((t) =>
      ["queued", "retry_wait"].includes(t.state),
    );
    return {
      ...this.settings(),
      occupied: occupied.length,
      queued: queued.length,
      waitReasons: [...new Set(queued.map((t) => t.waitReason!))],
      items: occupied.slice(0, 3),
      remaining: Math.max(0, occupied.length - 3),
      unseenAttention: this.store.unseenAttention(),
      ...(this.fatal
        ? { schedulerError: "任务调度已暂停，请前往任务管理查看" }
        : this.cleanupError
          ? { schedulerError: this.cleanupError }
          : {}),
    };
  }
  private maintainHistory(): void {
    if (this.now() < this.nextCleanupAt) return;
    try {
      const batch = this.store.pruneHistory(
        this.now(),
        this.cleanupCursor,
        (task) =>
          !this.executions.has(task.id) &&
          (task.type !== "publication" ||
            this.deps.canPrunePublication?.(task) === true),
      );
      this.cleanupCursor = batch.more ? batch.cursor : 0;
      this.nextCleanupAt = batch.more
        ? this.now() + 1000
        : this.now() + 3_600_000;
      const hadError = !!this.cleanupError;
      this.cleanupError = undefined;
      if (batch.removed || hadError) this.notify();
    } catch (error) {
      this.cleanupError = "任务历史清理失败，将自动重试";
      this.nextCleanupAt = this.now() + 60_000;
      console.error("Task history cleanup failed", error);
      this.notify();
    }
  }
  setMaxParallel(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError("最大并行任务数必须为正整数");
    this.store.setMaxParallel(value);
    this.notify();
    this.wake();
    return value;
  }
  rules(accountId: string) {
    accountId = this.deps.account(accountId).id;
    return (["account_profile_sync", "platform_content_sync"] as const).map(
      (type) => this.store.rule(accountId, type, this.now()),
    );
  }
  setRule(request: {
    accountId: string;
    type: SyncTaskType;
    enabled: boolean;
    intervalMs: number;
    resume?: boolean;
  }) {
    this.assertAccepting();
    this.assertSyncType(request.type);
    request = {
      ...request,
      accountId: this.deps.account(request.accountId).id,
    };
    if (
      (request.resume !== undefined && typeof request.resume !== "boolean") ||
      typeof request.enabled !== "boolean" ||
      !Number.isSafeInteger(request.intervalMs) ||
      request.intervalMs < syncMinIntervalMs
    )
      throw new TypeError("自动同步周期不能短于 1 小时");
    const rule = this.store.transaction(() => {
      const rule = this.store.rule(request.accountId, request.type, this.now());
      Object.assign(rule, {
        enabled: request.enabled,
        intervalMs: request.intervalMs,
        nextDueAt: this.now() + request.intervalMs,
        pausedReason:
          request.resume || !request.enabled || !rule.enabled
            ? null
            : rule.pausedReason,
      });
      this.store.saveRule(rule);
      if (!rule.enabled)
        for (const task of this.store.list(true)) {
          if (
            task.ruleId === rule.id &&
            !task.hasManualRequest &&
            task.attempt === 0 &&
            task.state === "queued"
          )
            this.end(task, "cancelled", "自动规则已停用");
        }
      return rule;
    });
    this.notify();
    this.wake();
    return rule;
  }
  enqueueSync(
    request: { accountId: string; type: SyncTaskType },
    source: "manual" | "runtime" = "manual",
  ): ScheduledTask {
    this.assertAccepting();
    this.assertSyncType(request.type);
    const task = this.store.transaction(() =>
      this.createSync(request.accountId, request.type, source),
    );
    this.notify();
    this.wake();
    return this.visible(task);
  }
  enqueuePublication(input: {
    accountId: string;
    requestId: string;
    source: "manual" | "runtime";
    input: unknown;
  }): ScheduledTask {
    this.assertAccepting();
    const task = this.store.transaction(() => {
      const existing = this.store.byRequest(input.requestId);
      if (existing) {
        if (existing.historyCleared)
          throw new TypeError("发布请求历史已清理，不得重放");
        if (existing.accountId !== input.accountId)
          throw new TypeError("request ID 已用于另一个账号");
        return existing;
      }
      const account = this.deps.account(input.accountId);
      return this.store.create(
        {
          type: "publication",
          accountId: account.id,
          platformId: account.platformId,
          source: input.source,
          requestId: input.requestId,
          input: input.input,
        },
        this.now(),
      );
    });
    this.notify();
    this.wake();
    return this.visible(task);
  }
  cancel(id: string): ScheduledTask {
    this.assertAccepting();
    const task = this.store.transaction(() => {
      const task = this.store.get(id);
      if (!task || !["queued", "retry_wait"].includes(task.state))
        throw new TypeError("任务已开始或已结束，不能取消排队");
      this.end(task, "cancelled", "已取消排队");
      return task;
    });
    this.notify();
    this.wake();
    return this.visible(task);
  }
  cancelRuntime(accountId: string): void {
    this.store.transaction(() => {
      for (const task of this.store.list(true))
        if (
          task.accountId === accountId &&
          task.source === "runtime" &&
          !task.hasDesktopRequest &&
          !task.ruleId &&
          ["queued", "retry_wait"].includes(task.state)
        )
          this.end(task, "cancelled", "账号外部访问权限已撤销");
    });
    this.notify();
  }
  async wait(id: string): Promise<unknown> {
    while (true) {
      const task = this.store.get(id);
      if (!task) throw new Error("任务不存在");
      if (isTerminalTask(task)) {
        if (task.state === "cancelled") throw new Error(task.phase);
        if (task.result !== null) return task.result;
        if (task.error)
          throw new TaskExecutionError(task.error.code, task.error.message);
        return task.result;
      }
      if (!this.started || this.fatal)
        throw new Error("应用已停止派发，排队任务将于下次启动恢复");
      await new Promise<void>((resolve) => {
        const done = () => {
          this.listeners.delete(done);
          resolve();
        };
        this.listeners.add(done);
      });
    }
  }
  private createSync(
    accountId: string,
    type: SyncTaskType,
    source: "automatic" | "manual" | "runtime",
    dueRuleId?: string,
  ): TaskRecord {
    const automatic = source === "automatic";
    const account = this.deps.account(accountId);
    const now = this.now();
    const rule = this.store.rule(account.id, type, now);
    let task = this.store
      .list(true)
      .find((t) => t.accountId === account.id && t.type === type);
    const shift = automatic || !task?.hasManualRequest;
    if (!task)
      task = this.store.create(
        {
          type,
          accountId: account.id,
          platformId: account.platformId,
          source,
          ruleId: automatic ? dueRuleId : undefined,
        },
        now,
      );
    if (!automatic) task.hasManualRequest = true;
    if (source === "manual") task.hasDesktopRequest = true;
    if (source === "runtime") task.hasRuntimeRequest = true;
    if (automatic) task.ruleId = dueRuleId ?? rule.id;
    task.updatedAt = now;
    this.store.save(task);
    if (shift) rule.nextDueAt = now + rule.intervalMs;
    rule.latestTaskId = task.id;
    this.store.saveRule(rule);
    return task;
  }
  private tick(): void {
    if (!this.started || this.ticking || this.fatal || this.paused) return;
    this.ticking = true;
    try {
      this.maintainHistory();
      for (const task of this.store.list(true)) {
        if (
          occupiedStates.includes(task.state) &&
          !this.executions.has(task.id)
        ) {
          const outcome = this.deps.reconcile(task, false);
          if (outcome) this.complete(task.id, outcome);
        }
      }
      for (const rule of this.store.rules())
        if (
          rule.enabled &&
          !rule.pausedReason &&
          rule.nextDueAt <= this.now()
        ) {
          try {
            this.store.transaction(() => {
              const current = this.store.rule(
                rule.accountId,
                rule.type,
                this.now(),
              );
              if (
                current.enabled &&
                !current.pausedReason &&
                current.nextDueAt <= this.now()
              )
                this.createSync(
                  rule.accountId,
                  rule.type,
                  "automatic",
                  rule.id,
                );
            });
          } catch (error) {
            rule.enabled = false;
            rule.pausedReason =
              error instanceof Error ? error.message : "账号不可用";
            this.store.saveRule(rule);
          }
          this.notify();
        }
      while (true) {
        const task = this.store.transaction(() => {
          const active = this.store.list(true);
          if (
            active.filter((t) => occupiedStates.includes(t.state)).length >=
            this.store.maxParallel()
          )
            return;
          const task = active.find(
            (t) =>
              ["queued", "retry_wait"].includes(t.state) &&
              t.nextAttemptAt <= this.now() &&
              this.cooldown(t) <= this.now() &&
              !active.some(
                (a) =>
                  a.accountId === t.accountId &&
                  occupiedStates.includes(a.state),
              ) &&
              this.deps.canStart(t.accountId),
          );
          if (!task) return;
          Object.assign(task, {
            state: "running",
            startedAt: task.startedAt ?? this.now(),
            updatedAt: this.now(),
            attempt: task.attempt + 1,
            phase: "执行中",
            error: null,
            progress: null,
            result: null,
          });
          this.store.save(task);
          this.store.recordAttempt(task);
          return task;
        });
        if (!task) break;
        // Register before executing. Every external operation follows the durable claim.
        const promise = Promise.resolve()
          .then(() => this.run(task))
          .finally(() => {
            this.executions.delete(task.id);
            this.notify();
            this.wake();
          });
        this.executions.set(task.id, promise);
        void promise.catch((error) => this.failClosed(error));
        this.notify();
      }
    } catch (error) {
      this.failClosed(error);
    } finally {
      this.ticking = false;
    }
  }
  private async run(task: TaskRecord): Promise<void> {
    try {
      const outcome = await this.deps.execute(task, {
        update: (patch) => {
          const current = this.store.get(task.id)!;
          Object.assign(current, patch, { updatedAt: this.now() });
          this.store.save(current);
          this.notify();
        },
      });
      this.complete(task.id, outcome);
    } catch (error) {
      const current = this.store.get(task.id)!;
      const failure =
        error instanceof TaskExecutionError
          ? error
          : new TaskExecutionError(
              "execution_failed",
              error instanceof Error ? error.message : String(error),
            );
      current.error = { code: failure.code, message: failure.message };
      if (failure.code === "rate_limited")
        this.store.database.connection
          .prepare(
            "INSERT INTO task_cooldowns VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)",
          )
          .run(
            current.platformId,
            this.now() + Math.max(failure.retryAfterMs, 60_000),
          );
      if (
        !failure.resourcesClosed ||
        (current.type === "publication" && current.businessStarted)
      ) {
        current.state = "finalizing";
        current.phase = "执行结果或资源退出尚未确认，需处理或重启恢复";
      } else if (
        current.type !== "publication" &&
        failure.retryable &&
        current.attempt < 3
      ) {
        current.state = "retry_wait";
        current.phase = "等待重试";
        current.nextAttemptAt =
          this.now() +
          Math.max(
            current.attempt === 1 ? 60_000 : 300_000,
            failure.retryAfterMs,
          );
      } else {
        current.state =
          current.type === "platform_content_sync" &&
          Math.max(current.retainedItems ?? 0, current.progress?.items ?? 0) > 0
            ? "partial"
            : "failed";
        current.phase = failure.message;
        current.endedAt = this.now();
      }
      if (
        [
          "authentication",
          "identity_mismatch",
          "verification_required",
        ].includes(failure.code) &&
        current.type !== "publication"
      ) {
        const rule = this.store.rule(
          current.accountId,
          current.type,
          this.now(),
        );
        rule.pausedReason = failure.message;
        this.store.saveRule(rule);
      }
      current.updatedAt = this.now();
      this.store.transaction(() => {
        this.store.save(current);
        this.store.recordAttempt(current);
      });
      this.notify();
    }
  }
  private complete(id: string, outcome: TaskOutcome): void {
    const current = this.store.get(id)!;
    Object.assign(current, {
      state: outcome.state,
      result: outcome.result ?? current.result,
      error: outcome.error ?? null,
      updatedAt: this.now(),
    });
    if (isTerminalTask(current)) {
      current.endedAt = this.now();
      current.phase =
        outcome.error?.message ??
        (
          {
            completed: "已完成",
            partial: "部分完成",
            failed: "执行失败",
            uncertain: "发布结果需核实",
            cancelled: "已结束",
          } as Record<string, string>
        )[current.state]!;
    } else if (current.state === "awaiting_confirmation")
      current.phase = "等待人工确认，占用并行名额";
    else if (current.state === "finalizing")
      current.phase = outcome.error?.message ?? "业务结果已保存，正在收尾";
    else if (current.state === "running" && current.type === "publication")
      current.phase = "观察发布结果";
    this.store.transaction(() => {
      this.store.save(current);
      this.store.recordAttempt(current);
    });
    this.notify();
  }
  private recover(): void {
    for (const task of this.store.list(true)) {
      if (!occupiedStates.includes(task.state)) continue;
      const outcome = this.deps.reconcile(task, true);
      if (outcome) {
        this.complete(task.id, outcome);
        continue;
      }
      if (task.type === "publication" && task.businessStarted) {
        this.end(task, "uncertain", "发布执行已开始，禁止自动重放，请核实结果");
      } else if (task.type !== "publication" && task.attempt >= 3)
        this.end(task, "failed", "同步中断，重试次数已用尽");
      else {
        task.state = task.type === "publication" ? "queued" : "retry_wait";
        task.nextAttemptAt = this.now() + (task.attempt > 1 ? 300_000 : 60_000);
        task.phase = "中断后等待安全恢复";
        this.store.save(task);
      }
    }
  }
  private cooldown(task: TaskRecord): number {
    return Number(
      this.store.database.connection
        .prepare("SELECT until_ms FROM task_cooldowns WHERE scope=?")
        .get(task.platformId)?.until_ms ?? 0,
    );
  }
  private visible(
    task: TaskRecord,
    active?: readonly TaskRecord[],
  ): ScheduledTask {
    const visible = publicTask(task);
    if (["queued", "retry_wait"].includes(task.state))
      visible.waitReason =
        task.nextAttemptAt > this.now()
          ? "等待重试"
          : this.cooldown(task) > this.now()
            ? "等待平台限流冷却"
            : (active
                  ? active.some(
                      (t) =>
                        t.accountId === task.accountId &&
                        occupiedStates.includes(t.state),
                    )
                  : this.isBusy(task.accountId)) ||
                !this.deps.canStart(task.accountId)
              ? "等待账号空闲"
              : "等待并行名额";
    return visible;
  }
  private end(task: TaskRecord, state: TaskState, phase: string): void {
    Object.assign(task, {
      state,
      phase,
      endedAt: this.now(),
      updatedAt: this.now(),
    });
    this.store.save(task);
    this.store.recordAttempt(task);
  }
  private notify(): void {
    for (const listener of [...this.listeners]) listener();
    try {
      this.deps.changed?.();
    } catch (error) {
      console.error("Task change notification failed", error);
    }
  }
  private wake(): void {
    queueMicrotask(() => this.tick());
  }
  private assertSyncType(type: string): asserts type is SyncTaskType {
    if (!["account_profile_sync", "platform_content_sync"].includes(type))
      throw new TypeError("无效同步类型");
  }
  private assertAccepting(): void {
    if (!this.started || this.fatal)
      throw new Error("任务调度尚未就绪或已经停止");
  }
  private failClosed(error: unknown): void {
    this.fatal = true;
    for (const listener of [...this.listeners]) listener();
    this.deps.onError?.(error);
  }
}
