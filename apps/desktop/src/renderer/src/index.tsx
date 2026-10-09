import { render } from "preact";

import { App } from "./app.js";
import { AppContext } from "./app-context.js";
import { loadPreferences } from "./preferences.js";
import { requireElement } from "./shared.js";
import { applyTheme, resolveTheme } from "./theme.js";

const { preferences, error: preferencesError } = await loadPreferences();
applyTheme(
  resolveTheme(
    preferences.appearance.theme,
    globalThis.matchMedia("(prefers-color-scheme: dark)").matches,
  ),
);
const context = new AppContext();
await context.initialize();
if (preferencesError)
  context.setStatus(
    "外观设置加载失败，请检查 preferences.json 后重试",
    "error",
  );

render(
  <App
    context={context}
    initialThemePreference={preferences.appearance.theme}
  />,
  requireElement(document, "#app"),
);
