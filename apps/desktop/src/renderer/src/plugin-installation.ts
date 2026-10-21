import type {
  BundledPlatformPlugin,
  PlatformPluginSummary,
} from "../../bridge/plugins.js";

export function visiblePlugins(plugins: PlatformPluginSummary[]) {
  return plugins.filter(
    (plugin) => plugin.installed || plugin.pending !== null,
  );
}

export function bundledPluginAction(
  bundle: BundledPlatformPlugin,
  installed?: PlatformPluginSummary,
) {
  if (installed?.pending) return { label: "待重启生效", action: null } as const;
  if (!installed?.installed)
    return { label: "安装", action: "install" } as const;
  if (installed.error) return { label: "重新安装", action: "install" } as const;
  if (!installed.enabled) return { label: "启用", action: "enable" } as const;
  if (!bundle.matchesInstalled)
    return { label: "替换为默认版本", action: "install" } as const;
  if (!installed.available)
    return { label: "重新安装", action: "install" } as const;
  return { label: "已安装", action: null } as const;
}
