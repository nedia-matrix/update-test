import type { PlatformModule } from "@nedia-matrix/platform-sdk";
import { toPlatformSummary } from "./platform-summary.js";
import type { PlatformSummary } from "../../bridge/contracts.js";

export interface PlatformRegistry {
  unavailable?(): readonly {
    id: string;
    displayName: string;
    iconUrl?: string;
    reason: string;
  }[];
  get(id: string): PlatformModule | undefined;
  require(id: string): PlatformModule;
  list(): readonly PlatformModule[];
}

class DesktopPlatformRegistry implements PlatformRegistry {
  private readonly modules = new Map<string, PlatformModule>();

  constructor(modules: readonly PlatformModule[]) {
    for (const module of modules) {
      if (this.modules.has(module.id)) {
        throw new TypeError(`Platform is already registered: ${module.id}`);
      }
      this.modules.set(module.id, module);
    }
  }

  get(id: string): PlatformModule | undefined {
    return this.modules.get(id);
  }

  require(id: string): PlatformModule {
    const module = this.get(id);
    if (!module) throw new TypeError(`Platform is not registered: ${id}`);
    return module;
  }

  list(): readonly PlatformModule[] {
    return [...this.modules.values()];
  }
}

export function createPlatformRegistry(
  modules: readonly PlatformModule[],
): PlatformRegistry {
  return new DesktopPlatformRegistry(modules);
}

export interface PlatformCatalogHost extends PlatformRegistry {
  replace(modules: readonly PlatformModule[]): void;
  setUnavailable(
    items: readonly {
      id: string;
      displayName: string;
      iconUrl?: string;
      reason: string;
    }[],
  ): void;
}

class DesktopPlatformCatalogHost implements PlatformCatalogHost {
  private snapshot: PlatformRegistry;
  private missing: readonly {
    id: string;
    displayName: string;
    iconUrl?: string;
    reason: string;
  }[] = [];
  unavailable() {
    return this.missing;
  }
  setUnavailable(items: typeof this.missing) {
    this.missing = items;
  }

  constructor(modules: readonly PlatformModule[]) {
    this.snapshot = createPlatformRegistry(modules);
  }

  get(id: string): PlatformModule | undefined {
    return this.snapshot.get(id);
  }

  require(id: string): PlatformModule {
    const reason = this.missing.find((item) => item.id === id)?.reason;
    if (reason) throw new TypeError(`平台不可用：${reason}`);
    return this.snapshot.require(id);
  }

  list(): readonly PlatformModule[] {
    return this.snapshot.list();
  }

  replace(modules: readonly PlatformModule[]): void {
    const next = createPlatformRegistry(modules);
    this.snapshot = next;
  }
}

export function createPlatformCatalogHost(
  modules: readonly PlatformModule[],
): PlatformCatalogHost {
  return new DesktopPlatformCatalogHost(modules);
}

export const desktopPlatformCatalog: PlatformCatalogHost =
  createPlatformCatalogHost([]);

export const desktopPlatformRegistry: PlatformRegistry = desktopPlatformCatalog;

export function platformSummaries(
  catalog: PlatformRegistry,
): PlatformSummary[] {
  return [
    ...catalog.list().map(toPlatformSummary),
    ...(catalog.unavailable?.() ?? []).map((item) => ({
      id: item.id,
      displayName: item.displayName,
      iconUrl: item.iconUrl,
      unavailableReason: item.reason,
      entryUrl: "",
      rulesVersion: "",
      implementationStatus: "route-only" as const,
      loginEntries: [],
      publishCapabilities: [],
    })),
  ];
}
export function desktopPlatformSummaries(): PlatformSummary[] {
  return platformSummaries(desktopPlatformCatalog);
}
