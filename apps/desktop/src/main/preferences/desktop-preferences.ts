import { app } from "electron";
import { PreferencesStore } from "./preferences-store.js";
let store: PreferencesStore | undefined;
export function desktopPreferences(): PreferencesStore {
  return (store ??= new PreferencesStore(app.getPath("userData")));
}
