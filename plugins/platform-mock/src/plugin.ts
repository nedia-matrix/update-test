import type { PlatformPluginEntry } from "@nedia-matrix/platform-sdk";
import { mockPlatformModule } from "./platform.js";
export const plugin: PlatformPluginEntry = { module: mockPlatformModule };
