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
): void {
  ipcMain.handle(
    ipcChannels.getPreferences,
    (_event, request?: GetPreferencesRequest) => store.get(request),
  );
  ipcMain.handle(
    ipcChannels.updatePreferences,
    (_event, request: UpdatePreferencesRequest) => {
      const changesSource = request?.updates !== undefined;
      if (changesSource) sourceChanges?.assertIdle();
      const result = store.update(request);
      if (changesSource) sourceChanges?.changed();
      return result;
    },
  );
}
