import { ipcMain } from "electron";
import { ipcChannels } from "../../../bridge/channels.js";
import type {
  RuntimeAccountAccess as AccountAccessRequest,
  UpdateLocalRuntimeSettings,
} from "../../../bridge/runtime-access.js";
import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";
import type { LocalRuntimeHttpServer } from "../http/local-runtime-http-server.js";
import type { RuntimeAccess } from "../security/runtime-access.js";

export function registerRuntimeAccessIpc(
  application: NediaMatrixUseCases,
  server: LocalRuntimeHttpServer,
  access: RuntimeAccess,
): void {
  ipcMain.handle(ipcChannels.getLocalRuntimeSettings, () => access.view());
  ipcMain.handle(
    ipcChannels.updateLocalRuntimeSettings,
    async (_event, request: UpdateLocalRuntimeSettings) => {
      await server.updateSettings(request);
      return access.view();
    },
  );
  const requireAccount = (accountId: string) => {
    if (
      typeof accountId !== "string" ||
      !application.accounts.list().some((account) => account.id === accountId)
    )
      throw new TypeError("账号不存在");
  };
  ipcMain.handle(
    ipcChannels.getRuntimeAccountAccess,
    (_event, accountId: string) => {
      requireAccount(accountId);
      return { accountId, allowed: access.allowed(accountId) };
    },
  );
  ipcMain.handle(
    ipcChannels.setRuntimeAccountAccess,
    (_event, request: AccountAccessRequest) => {
      requireAccount(request?.accountId);
      access.setAllowed(request.accountId, request.allowed);
      if (!request.allowed && "revokeRuntimeTasks" in application)
        (
          application as NediaMatrixUseCases & {
            revokeRuntimeTasks(id: string): void;
          }
        ).revokeRuntimeTasks(request.accountId);
      server.publishAccountsChanged();
      return {
        accountId: request.accountId,
        allowed: access.allowed(request.accountId),
      };
    },
  );
}
