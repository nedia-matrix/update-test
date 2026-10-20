import { ipcMain } from "electron";
import { ipcChannels } from "../../bridge/channels.js";
import type {
  GetPreferencesRequest,
  UpdatePreferencesRequest,
} from "../../bridge/preferences.js";
import type { PreferencesStore } from "./preferences-store.js";

export function registerPreferencesIpc(
  store: PreferencesStore,
  sourceChanges?: { assertIdle(): void; changed(): void },
  assertFingerprintReady?: () => Promise<void>,
): void {
  ipcMain.handle(
    ipcChannels.getPreferences,
    (_event, request?: GetPreferencesRequest) => store.get(request),
  );
  ipcMain.handle(
    ipcChannels.updatePreferences,
    (_event, request: UpdatePreferencesRequest) => {
      const changesSource = request?.updates?.sourceUrl !== undefined;
      if (changesSource) sourceChanges?.assertIdle();
      const save = () => {
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
