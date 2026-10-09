export type AutomationNotice =
  | { kind: "account.synced"; accountId: string }
  | {
      kind: "publish.awaiting_confirmation";
      accountId: string;
      publicationId: string;
    }
  | {
      kind:
        "publish.preparation_failed" | "publish.failed" | "publish.uncertain";
      accountId: string;
      publicationId?: string;
      message?: string;
      pageAvailable: boolean;
    };

export interface AutomationNoticeSink {
  show(notice: AutomationNotice): void;
}

// Presentation failure must never change a completed business operation.
export function showAutomationNotice(
  sink: AutomationNoticeSink | undefined,
  notice: AutomationNotice,
): void {
  try {
    sink?.show(notice);
  } catch (error) {
    console.error("Failed to show automation notice", error);
  }
}

export const automationNoticeMessages = {
  "account.synced": {
    title: "资料同步完成",
    body: "账号资料已同步。你可以关闭浏览器窗口，也可以保留窗口继续操作。",
  },
  "publish.awaiting_confirmation": {
    title: "自动填充完毕",
    body: "你可以在浏览器中自行检查、修改内容，最后必须亲自点击「发布」按钮。请保留浏览器窗口，以便获取发布结果。",
  },
  "publish.preparation_failed": {
    title: "发布内容填充失败",
    body: "草稿可能未填完整，本次发布任务已停止跟踪。如自行发布，应用不会记录这次操作的结果。",
  },
  "publish.failed": {
    title: "平台返回发布失败",
    body: "请先核对平台作品列表，不要直接重复发布。本次任务已停止跟踪，再次提交不会被记录。",
  },
  "publish.uncertain": {
    title: "发布结果无法确认",
    body: "请先核对平台作品列表，不要直接重复发布。本次任务已停止跟踪，再次提交不会被记录。",
  },
} as const;
