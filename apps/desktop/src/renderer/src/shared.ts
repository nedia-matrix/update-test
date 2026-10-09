import type { PlatformAccountView } from "@nedia-matrix/account-management";
import type { PublicationStatus } from "@nedia-matrix/publishing";
import type { PlatformSummary } from "../../bridge/contracts.js";

export const publicationStateLabels: Readonly<
  Record<PublicationStatus, string>
> = {
  draft: "草稿",
  validated: "已校验",
  scheduled: "已计划",
  preparing: "准备中",
  awaiting_confirmation: "等待手动发布",
  submitting: "提交中",
  verifying: "确认中",
  published: "发布成功",
  uncertain: "结果待核实",
  failed: "失败",
  retrying: "重试中",
  rejected: "已拒绝",
  cancelled: "已取消",
};

export type PublicationDisplayGroup =
  | "action_required"
  | "in_progress"
  | "attention_required"
  | "completed"
  | "closed";

export const publicationDisplayGroupLabels: Readonly<
  Record<PublicationDisplayGroup, string>
> = {
  action_required: "待操作",
  in_progress: "进行中",
  attention_required: "发布异常",
  completed: "已完成",
  closed: "已结束",
};

export const publicationDisplayGroupOrder: readonly PublicationDisplayGroup[] =
  [
    "action_required",
    "in_progress",
    "attention_required",
    "completed",
    "closed",
  ];

export function publicationDisplayGroup(
  state: PublicationStatus,
): PublicationDisplayGroup {
  switch (state) {
    case "awaiting_confirmation":
      return "action_required";
    case "draft":
    case "validated":
    case "scheduled":
    case "preparing":
    case "submitting":
    case "verifying":
    case "retrying":
      return "in_progress";
    case "uncertain":
    case "failed":
      return "attention_required";
    case "published":
      return "completed";
    case "rejected":
    case "cancelled":
      return "closed";
  }
}

export function requireElement<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Desktop page is missing ${selector}`);
  return element;
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN");
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function platformFor(
  platforms: readonly PlatformSummary[],
  platformId: string,
): PlatformSummary | undefined {
  return platforms.find((platform) => platform.id === platformId);
}

export function accountLabel(
  account: PlatformAccountView,
  platforms: readonly PlatformSummary[],
): string {
  const platform = platformFor(platforms, account.platformId);
  return `${account.nickname ?? account.displayName} · ${platform?.displayName ?? account.platformId}`;
}

export function accountStatus(account: PlatformAccountView): string {
  switch (account.status) {
    case "authenticated":
      return "已登录";
    case "login_required":
      return "需要登录";
    case "unknown":
      return "待确认";
  }
}
