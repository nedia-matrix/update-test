export type AutomationNotice =
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

export const automationNoticeMessages = {
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
