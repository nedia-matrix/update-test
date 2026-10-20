import type { PlatformModule } from "./platform-module.js";

export interface PlatformAccountSelection {
  readonly platformId: string;
}
export interface AccountPlatformCatalog {
  require(id: string): PlatformModule;
}
export function resolveAccountPlatform(
  catalog: AccountPlatformCatalog,
  account: PlatformAccountSelection,
): PlatformModule {
  return catalog.require(account.platformId);
}
export function samePlatform(
  _catalog: AccountPlatformCatalog,
  left: string,
  right: string,
): boolean {
  return left === right;
}
