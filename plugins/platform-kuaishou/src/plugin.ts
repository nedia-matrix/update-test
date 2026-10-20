import type { PlatformPluginEntry } from "@nedia-matrix/platform-sdk";
import { kuaishouPlatformModule } from "./platform.js";
export const plugin: PlatformPluginEntry = { module: kuaishouPlatformModule };
