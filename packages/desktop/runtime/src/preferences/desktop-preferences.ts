import { businessDataDirectory } from "../runtime/desktop-data-paths.js";
import { PreferencesStore } from "./preferences-store.js";
let store: PreferencesStore | undefined;
export function desktopPreferences(): PreferencesStore {
  return (store ??= new PreferencesStore(businessDataDirectory()));
}
