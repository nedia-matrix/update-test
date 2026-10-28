import { ipcMain } from "electron";
import { ipcChannels } from "../../bridge/channels.js";
import type { NediaMatrixUseCases } from "../application/nedia-matrix-application.js";

export function registerTaskIpc(application: NediaMatrixUseCases): void {
  const tasks = () => {
    if (!application.tasks) throw new Error("任务管理不可用");
    return application.tasks;
  };
  ipcMain.handle(ipcChannels.clearTaskHistory, (_event, request) =>
    tasks().clearHistory(request),
  );
  ipcMain.handle(ipcChannels.getTaskSettings, () => tasks().settings());
  ipcMain.handle(ipcChannels.setTaskRetentionDays, (_event, value) =>
    tasks().setRetentionDays(value),
  );
  ipcMain.handle(ipcChannels.getTaskSummary, () => tasks().summary());
  ipcMain.handle(ipcChannels.acknowledgeTaskAttention, (_event, items) =>
    tasks().acknowledgeAttention(items),
  );
  ipcMain.handle(ipcChannels.queryScheduledTasks, (_event, request) =>
    tasks().query(request),
  );
  ipcMain.handle(ipcChannels.getTaskByRequest, (_event, id) =>
    tasks().byRequest(id),
  );
  ipcMain.handle(ipcChannels.getScheduledTask, (_event, id) => tasks().get(id));
  ipcMain.handle(ipcChannels.cancelScheduledTask, (_event, id) =>
    tasks().cancel(id),
  );
  ipcMain.handle(ipcChannels.enqueueSyncTask, (_event, request) =>
    tasks().enqueueSync(request),
  );
  ipcMain.handle(ipcChannels.getSyncRules, (_event, accountId) =>
    tasks().rules(accountId),
  );
  ipcMain.handle(ipcChannels.setSyncRule, (_event, request) =>
    tasks().setRule(request),
  );
  ipcMain.handle(ipcChannels.setTaskMaxParallel, (_event, value) =>
    tasks().setMaxParallel(value),
  );
}
