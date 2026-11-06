import { ipcMain } from "../runtime/runtime-host.js";
import { ipcChannels } from "@nedia-matrix/desktop-contracts/channels";
import type {
  GetPreferencesRequest,
  UpdatePreferencesRequest,
} from "@nedia-matrix/desktop-contracts/preferences";
import type { PreferencesStore } from "./preferences-store.js";

export function registerPreferencesIpc(
  store: PreferencesStore,
  sourceChanges?: { assertIdle(): void; changed(): void },
  assertFingerprintReady?: () => Promise<void>,
  assertAcceptingCommands: () => void = () => {},
): void {
  ipcMain.handle(
    ipcChannels.getPreferences,
    (_event, request?: GetPreferencesRequest) => {
      assertAcceptingCommands();
      return store.get(request);
    },
  );
  ipcMain.handle(
    ipcChannels.updatePreferences,
    (_event, request: UpdatePreferencesRequest) => {
      assertAcceptingCommands();
      const changesSource = request?.updates?.sourceUrl !== undefined;
      if (changesSource) sourceChanges?.assertIdle();
      const save = () => {
        assertAcceptingCommands();
        const result = store.update(request);
        if (changesSource) sourceChanges?.changed();
        return result;
      };
      if (request?.browser?.defaultProvider === "fingerprint") {
        if (!assertFingerprintReady) throw new Error("定制浏览器尚未就绪");
        return assertFingerprintReady().then(() => {
          if (changesSource) sourceChanges?.assertIdle();
          return save();
        });
      }
      return save();
    },
  );
}
