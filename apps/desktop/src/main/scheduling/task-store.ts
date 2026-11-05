import { randomUUID } from "node:crypto";
import type {
  ScheduledTask,
  SyncRule,
  TaskQuery,
  TaskState,
  TaskType,
  SyncTaskType,
  TaskAttempt,
  TaskSettings,
  TaskClearScope,
  TaskClearState,
} from "../../bridge/tasks.js";
import { syncDefaultIntervalMs, taskGroups } from "../../bridge/tasks.js";
import type { DesktopMetadataDatabase } from "../persistence/desktop-metadata-database.js";

export interface TaskRecord extends ScheduledTask {
  input: unknown;
  result: unknown;
}
export const occupiedStates: TaskState[] = [
  "running",
  "awaiting_confirmation",
  "finalizing",
];
export const terminalStates: TaskState[] = [
  "completed",
  "partial",
  "failed",
  "cancelled",
  "uncertain",
];
export const isTerminalTask = (task: ScheduledTask) =>
  terminalStates.includes(task.state);
export function publicTask(task: TaskRecord): ScheduledTask {
  const { input: _input, result: _result, ...visible } = task;
  return visible;
}

export class TaskStore {
  constructor(readonly database: DesktopMetadataDatabase) {}
  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }
  get(id: string): TaskRecord | undefined {
    return this.decode(
      this.database.connection
        .prepare("SELECT sequence, record FROM scheduled_tasks WHERE id=?")
        .get(id),
    );
  }
  byRequest(requestId: string): TaskRecord | undefined {
    const task = this.decode(
      this.database.connection
        .prepare(
          "SELECT sequence, record FROM scheduled_tasks WHERE request_id=?",
        )
        .get(requestId),
    );
    return task ?? this.requestMarker(requestId);
  }
  private requestMarker(requestId: string): TaskRecord | undefined {
    const row = this.database.connection
      .prepare("SELECT record FROM task_request_markers WHERE request_id=?")
      .get(requestId);
    if (!row) return;
    return {
      ...JSON.parse(String(row.record)),
      input: null,
      result: null,
    } as TaskRecord;
  }
  list(activeOnly = false): TaskRecord[] {
    return this.database.connection
      .prepare(
        `SELECT sequence, record FROM scheduled_tasks ${activeOnly ? "WHERE state NOT IN ('completed','partial','failed','cancelled','uncertain')" : ""} ORDER BY sequence`,
      )
      .all()
      .map((row) => this.decode(row)!);
  }
  query(query: TaskQuery): {
    items: TaskRecord[];
    total: number;
    counts: Record<TaskState, number>;
  } {
    const parts: string[] = [];
    const args: (string | number)[] = [];
    for (const [key, column] of [
      ["type", "type"],
      ["accountId", "account_id"],
      ["platformId", "platform_id"],
    ] as const) {
      if (query[key] !== undefined) {
        parts.push(`${column}=?`);
        args.push(query[key]!);
      }
    }
    const countWhere = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
    const countArgs = [...args];
    if (query.state) {
      parts.push("state=?");
      args.push(query.state);
    }
    if (query.group) {
      parts.push(
        `state IN (${taskGroups[query.group].map(() => "?").join(",")})`,
      );
      args.push(...taskGroups[query.group]);
    }
    const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
    const sql = this.database.connection;
    const total = Number(
      sql
        .prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks ${where}`)
        .get(...args)!.n,
    );
    const counts = Object.fromEntries(
      [...occupiedStates, ...terminalStates, "queued", "retry_wait"].map(
        (s) => [s, 0],
      ),
    ) as Record<TaskState, number>;
    for (const row of sql
      .prepare(
        `SELECT state, COUNT(*) AS n FROM scheduled_tasks ${countWhere} GROUP BY state`,
      )
      .all(...countArgs))
      counts[row.state as TaskState] = Number(row.n);
    const items = sql
      .prepare(
        `SELECT sequence, record FROM scheduled_tasks ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, query.limit ?? 30, query.offset ?? 0)
      .map((row) => this.decode(row)!);
    return { items, total, counts };
  }
  create(
    input: {
      type: TaskType;
      accountId: string;
      platformId: string;
      source: ScheduledTask["source"];
      requestId?: string;
      ruleId?: string;
      input?: unknown;
    },
    now: number,
  ): TaskRecord {
    if (input.requestId && this.requestMarker(input.requestId))
      throw new TypeError("发布请求历史已清理，不得重放");
    const task: TaskRecord = {
      id: randomUUID(),
      sequence: 0,
      type: input.type,
      accountId: input.accountId,
      platformId: input.platformId,
      source: input.source,
      hasManualRequest: input.source !== "automatic",
      hasDesktopRequest: input.source === "manual",
      hasRuntimeRequest: input.source === "runtime",
      ruleId: input.ruleId ?? null,
      requestId: input.requestId ?? null,
      publicationId: null,
      state: "queued",
      phase: "等待执行",
      createdAt: now,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
      attempt: 0,
      nextAttemptAt: 0,
      error: null,
      progress: null,
      businessStarted: false,
      input: input.input ?? null,
      result: null,
    };
    const row = this.database.connection
      .prepare(
        "INSERT INTO scheduled_tasks(id,type,account_id,platform_id,request_id,state,record) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        task.id,
        task.type,
        task.accountId,
        task.platformId,
        task.requestId,
        task.state,
        JSON.stringify(task),
      );
    task.sequence = Number(row.lastInsertRowid);
    return task;
  }
  save(task: TaskRecord): void {
    if (["failed", "partial", "uncertain"].includes(task.state)) {
      const prior = this.get(task.id);
      task.attentionVersion =
        prior?.state === task.state &&
        JSON.stringify(prior.error) === JSON.stringify(task.error) &&
        JSON.stringify(prior.result) === JSON.stringify(task.result) &&
        prior.endedAt === task.endedAt
          ? (prior.attentionVersion ?? randomUUID())
          : randomUUID();
    } else delete task.attentionVersion;
    this.database.connection
      .prepare("UPDATE scheduled_tasks SET state=?, record=? WHERE id=?")
      .run(task.state, JSON.stringify(task), task.id);
  }
  attempts(id: string): TaskAttempt[] {
    return this.database.connection
      .prepare(
        "SELECT record FROM task_attempts WHERE task_id=? ORDER BY attempt",
      )
      .all(id)
      .map((row) => JSON.parse(String(row.record)) as TaskAttempt);
  }
  recordAttempt(task: TaskRecord): void {
    if (task.attempt < 1) return;
    const existing = this.attempts(task.id).find(
      (a) => a.attempt === task.attempt,
    );
    const result = task.result as { id?: string } | null;
    const attempt: TaskAttempt = {
      attempt: task.attempt,
      startedAt: existing?.startedAt ?? task.updatedAt,
      endedAt:
        task.state === "retry_wait" || isTerminalTask(task)
          ? task.updatedAt
          : null,
      state: task.state,
      runId:
        task.type === "platform_content_sync" && typeof result?.id === "string"
          ? result.id
          : null,
      error: task.error,
    };
    this.database.connection
      .prepare(
        "INSERT INTO task_attempts VALUES (?,?,?) ON CONFLICT(task_id,attempt) DO UPDATE SET record=excluded.record",
      )
      .run(task.id, task.attempt, JSON.stringify(attempt));
  }
  rules(accountId?: string): SyncRule[] {
    const sql = this.database.connection;
    return (
      accountId
        ? sql
            .prepare("SELECT record FROM sync_rules WHERE account_id=?")
            .all(accountId)
        : sql.prepare("SELECT record FROM sync_rules").all()
    ).map((row) => JSON.parse(String(row.record)) as SyncRule);
  }
  rule(accountId: string, type: SyncTaskType, now: number): SyncRule {
    return (
      this.rules(accountId).find((r) => r.type === type) ?? {
        id: randomUUID(),
        accountId,
        type,
        enabled: false,
        intervalMs: syncDefaultIntervalMs,
        nextDueAt: now + syncDefaultIntervalMs,
        latestTaskId: null,
        pausedReason: null,
      }
    );
  }
  saveRule(rule: SyncRule): void {
    this.database.connection
      .prepare(
        "INSERT INTO sync_rules(id,account_id,type,record) VALUES (?,?,?,?) ON CONFLICT(account_id,type) DO UPDATE SET record=excluded.record",
      )
      .run(rule.id, rule.accountId, rule.type, JSON.stringify(rule));
  }
  maxParallel(): number {
    return Number(
      this.database.connection
        .prepare("SELECT max_parallel FROM task_scheduler_settings WHERE id=1")
        .get()!.max_parallel,
    );
  }
  setMaxParallel(value: number): void {
    this.database.connection
      .prepare("UPDATE task_scheduler_settings SET max_parallel=? WHERE id=1")
      .run(value);
  }
  settings(): TaskSettings {
    const row = this.database.connection
      .prepare(
        "SELECT max_parallel,retention_days FROM task_scheduler_settings WHERE id=1",
      )
      .get()!;
    return {
      maxParallel: Number(row.max_parallel),
      retentionDays: Number(row.retention_days),
    };
  }
  setRetentionDays(days: number): void {
    this.database.connection
      .prepare("UPDATE task_scheduler_settings SET retention_days=? WHERE id=1")
      .run(days);
  }
  unseenAttention(): number {
    return Number(
      this.database.connection
        .prepare(
          `SELECT COUNT(*) AS n FROM scheduled_tasks t
      LEFT JOIN task_attention_seen s ON s.task_id=t.id
      WHERE t.state IN ('failed','partial','uncertain')
      AND (s.version IS NULL OR s.version != COALESCE(json_extract(t.record,'$.attentionVersion'), t.state || ':' || json_extract(t.record,'$.updatedAt')))`,
        )
        .get()!.n,
    );
  }
  acknowledgeAttention(items: { id: string; version: string }[]): void {
    this.transaction(() => {
      for (const item of items) {
        const task = this.get(item.id);
        if (
          task?.attentionVersion !== item.version ||
          !["failed", "partial", "uncertain"].includes(task.state)
        )
          continue;
        this.database.connection
          .prepare(
            "INSERT INTO task_attention_seen VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version",
          )
          .run(item.id, item.version);
      }
    });
  }
  /** Scan bounded batches, including skipped unsafe records without starving later history. */
  pruneHistory(
    now: number,
    after: number,
    canPrune: (task: TaskRecord) => boolean,
  ): { cursor: number; removed: number; more: boolean } {
    return this.transaction(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT sequence,record FROM scheduled_tasks
        WHERE state IN ('completed','partial','failed','cancelled','uncertain') AND sequence>?
        AND json_extract(record,'$.endedAt')<=? ORDER BY sequence LIMIT 100`,
        )
        .all(after, now - this.settings().retentionDays * 86_400_000);
      let removed = 0;
      for (const row of rows) {
        const task = this.decode(row)!;
        if (!canPrune(task)) continue;
        this.removeHistory(task);
        removed++;
      }
      return {
        cursor: Number(rows.at(-1)?.sequence ?? after),
        removed,
        more: rows.length === 100,
      };
    });
  }
  historyCandidates(scope: TaskClearScope): TaskRecord[] {
    const clauses = [
      "state IN ('completed','cancelled','failed','partial','uncertain')",
    ];
    const args: string[] = [];
    for (const [key, column] of [
      ["type", "type"],
      ["accountId", "account_id"],
      ["platformId", "platform_id"],
    ] as const) {
      if (scope[key] !== undefined) {
        clauses.push(`${column}=?`);
        args.push(scope[key]);
      }
    }
    return this.database.connection
      .prepare(
        `SELECT sequence,record FROM scheduled_tasks WHERE ${clauses.join(" AND ")} ORDER BY sequence`,
      )
      .all(...args)
      .map((row) => this.decode(row)!);
  }
  clearHistory(
    scope: TaskClearScope,
    state: TaskClearState,
    canClear: (task: TaskRecord) => boolean,
  ): number {
    return this.transaction(() => {
      let removed = 0;
      for (const task of this.historyCandidates(scope)) {
        if (!taskGroups[state].includes(task.state) || !canClear(task))
          continue;
        this.removeHistory(task);
        removed++;
      }
      return removed;
    });
  }
  /** Caller owns the transaction, shared by retention and explicit clearing. */
  private removeHistory(task: TaskRecord): void {
    if (task.requestId) {
      // Keep identity and final state, never content, inputs, progress or error details.
      const marker: TaskRecord = {
        ...task,
        historyCleared: true,
        phase: "任务历史已清理，不可重放",
        input: null,
        result: null,
        error: null,
        progress: null,
      };
      delete marker.attempts;
      delete marker.attentionVersion;
      delete marker.retainedItems;
      const { input: _input, result: _result, ...identity } = marker;
      this.database.connection
        .prepare("INSERT INTO task_request_markers VALUES (?,?)")
        .run(task.requestId, JSON.stringify(identity));
    }
    this.database.connection
      .prepare("DELETE FROM task_attempts WHERE task_id=?")
      .run(task.id);
    for (const rule of this.rules(task.accountId)) {
      if (rule.latestTaskId === task.id) {
        rule.latestTaskId = null;
        this.saveRule(rule);
      }
    }
    this.database.connection
      .prepare("DELETE FROM scheduled_tasks WHERE id=?")
      .run(task.id);
  }
  private decode(
    row: Record<string, unknown> | undefined,
  ): TaskRecord | undefined {
    if (!row) return;
    const task = {
      ...JSON.parse(String(row.record)),
      sequence: Number(row.sequence),
    } as TaskRecord;
    if (["failed", "partial", "uncertain"].includes(task.state))
      task.attentionVersion ??= `${task.state}:${task.updatedAt}`;
    return task;
  }
}
