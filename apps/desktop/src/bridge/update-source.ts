declare const __NEDIA_TAURI_BUILD__: boolean;
declare const __NEDIA_DEFAULT_UPDATE_SOURCE_URL__: string;
export const IS_TAURI =
  typeof __NEDIA_TAURI_BUILD__ !== "undefined" && __NEDIA_TAURI_BUILD__;
// The installed product keeps its identity when a later version changes shells.
export const APPLICATION_ID = "com.nediamatrix.desktop";
export const UPDATE_MANIFEST_NAME = "update-manifest";
export const DEFAULT_UPDATE_SOURCE_URL =
  typeof __NEDIA_DEFAULT_UPDATE_SOURCE_URL__ !== "undefined"
    ? __NEDIA_DEFAULT_UPDATE_SOURCE_URL__
    : "https://github.com/nedia-matrix/desktop";
