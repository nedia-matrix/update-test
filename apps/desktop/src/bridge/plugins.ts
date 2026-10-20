export interface PlatformPluginSummary {
  iconUrl?: string;
  id: string;
  platformId: string;
  displayName: string;
  version: string | null;
  enabled: boolean;
  installed: boolean;
  available: boolean;
  error: string | null;
  pending: "install" | "enable" | "disable" | "remove" | null;
}
export interface PlatformPluginChange {
  id: string;
  action: "enable" | "disable" | "remove";
}
