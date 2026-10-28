export type TaskType =
  "account_profile_sync" | "platform_content_sync" | "publication";
export type SyncTaskType = Exclude<TaskType, "publication">;
export type TaskState =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "retry_wait"
  | "finalizing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "uncertain";
export interface TaskAttempt {
  attempt: number;
  startedAt: number;
  endedAt: number | null;
  state: TaskState;
  runId: string | null;
  error: { code: string; message: string } | null;
}
export interface ScheduledTask {
  attempts?: TaskAttempt[];
  /** Identity-only response after history retention; never replay this request. */
  historyCleared?: boolean;
  attentionVersion?: string;
  id: string;
  sequence: number;
  type: TaskType;
  accountId: string;
  platformId: string;
  source: "manual" | "automatic" | "runtime";
  hasManualRequest: boolean;
  hasDesktopRequest?: boolean;
  hasRuntimeRequest?: boolean;
  ruleId: string | null;
  requestId: string | null;
  publicationId: string | null;
  state: TaskState;
  phase: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  attempt: number;
  nextAttemptAt: number;
  error: { code: string; message: string } | null;
  progress: { pages: number; items: number } | null;
  businessStarted: boolean;
  retainedItems?: number;
  waitReason?: string;
}
export interface SyncRule {
  id: string;
  accountId: string;
  type: SyncTaskType;
  enabled: boolean;
  intervalMs: number;
  nextDueAt: number;
  latestTaskId: string | null;
  pausedReason: string | null;
}
export type TaskGroup =
  | "in_progress"
  | "completed"
  | "failed"
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "attention"
  | "active"
  | "history";
export const taskGroups: Record<TaskGroup, readonly TaskState[]> = {
  in_progress: [
    "queued",
    "running",
    "awaiting_confirmation",
    "retry_wait",
    "finalizing",
    "partial",
    "cancelled",
    "uncertain",
  ],
  completed: ["completed"],
  failed: ["failed"],
  active: [
    "queued",
    "retry_wait",
    "running",
    "finalizing",
    "awaiting_confirmation",
    "failed",
    "partial",
    "uncertain",
  ],
  history: ["completed", "cancelled"],
  queued: ["queued", "retry_wait"],
  running: ["running", "finalizing"],
  awaiting_confirmation: ["awaiting_confirmation"],
  attention: ["failed", "partial", "uncertain"],
};
export interface TaskQuery {
  group?: TaskGroup;
  type?: TaskType;
  accountId?: string;
  platformId?: string;
  state?: TaskState;
  offset?: number;
  limit?: number;
}
export type TaskClearState = "completed" | "failed";
export type TaskClearScope = Pick<
  TaskQuery,
  "type" | "accountId" | "platformId"
>;
export interface ClearTaskHistoryRequest extends TaskClearScope {
  state: TaskClearState;
}
export interface TaskQueryResult {
  /** Safe-to-clear counts for type/account/platform, independent of group/page. */
  clearable: Record<TaskClearState, number>;
  schedulerError?: string;
  items: ScheduledTask[];
  total: number;
  counts: Record<TaskState, number>;
  occupied: number;
  awaitingConfirmation: number;
  maxParallel: number;
}
export interface TaskSettings {
  maxParallel: number;
  retentionDays: number;
}
export interface TaskSummary extends TaskSettings {
  occupied: number;
  queued: number;
  waitReasons: string[];
  items: ScheduledTask[];
  remaining: number;
  unseenAttention: number;
  schedulerError?: string;
}
export interface TaskUseCases {
  clearHistory(request: ClearTaskHistoryRequest): { removed: number };
  settings(): TaskSettings;
  setRetentionDays(value: number): TaskSettings;
  summary(): TaskSummary;
  acknowledgeAttention(items: { id: string; version: string }[]): void;
  query(request?: TaskQuery): TaskQueryResult;
  get(id: string): ScheduledTask | null;
  byRequest(requestId: string): ScheduledTask | null;
  cancel(id: string): ScheduledTask;
  enqueueSync(request: {
    accountId: string;
    type: SyncTaskType;
  }): ScheduledTask;
  rules(accountId: string): SyncRule[];
  setRule(request: {
    accountId: string;
    type: SyncTaskType;
    enabled: boolean;
    intervalMs: number;
    resume?: boolean;
  }): SyncRule;
  setMaxParallel(value: number): number;
}
export const syncDefaultIntervalMs = 24 * 60 * 60 * 1000;
export const syncMinIntervalMs = 60 * 60 * 1000;
