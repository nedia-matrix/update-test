import type { PlatformSettings } from "./settings.js";
import type { PlatformModule } from "./platform-module.js";
import type { PlatformDataClient, PlatformJsonResponse } from "./data.js";
import type { PublishAbortSignal, PluginPublishSession } from "./runtime.js";

export interface PluginAbortSignal extends PublishAbortSignal {
  readonly reason?: unknown;
  throwIfAborted(): void;
}

/** Publication version is provenance only. Protocol revisions control compatibility. */
export interface PlatformPluginSource {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly packageDigest: string;
}
export interface PlatformPluginManifest {
  readonly kind: "nedia.platform-plugin";
  readonly protocol: 1;
  readonly sdk: 1;
  readonly automation: 1;
  readonly id: string;
  readonly version: string;
  readonly platformId: string;
  readonly displayName: string;
  readonly entry: string;
  readonly icon?: string;
  readonly capabilities: readonly string[];
  readonly files: readonly { path: string; size: number; sha256: string }[];
}
export interface PluginAccount {
  readonly platformId: string;
  readonly identityScheme: string | null;
  readonly externalAccountId: string | null;
}
export interface LocalVideoResource {
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly cover: Uint8Array;
  readPart(
    offset: number,
    length: number,
    signal: PluginAbortSignal,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}
/** Host adapters retain ownership of browser objects, credentials and media grants. */
export interface PlatformExecutionHost {
  assertOwnership(): void;
  cookies(
    url: string,
  ): Promise<
    readonly { name: string; value: string; domain: string; path: string }[]
  >;
  openScript(options: {
    assets: readonly { name: string; sha256: string }[];
    functionName: string;
    requiredFunctions: readonly string[];
    writableCookie?: { name: string; argumentIndex: number };
  }): Promise<{
    invoke(args: readonly unknown[]): Promise<unknown>;
    close(): Promise<void>;
  }>;
  requestJson(input: {
    url: string;
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
    body?: string;
    timeoutMs: number;
  }): Promise<PlatformJsonResponse>;
  observeJson(input: {
    pageUrl: string;
    responseUrl: string;
    signal?: PluginAbortSignal;
  }): Promise<PlatformJsonResponse>;
  pace<T>(signal: PluginAbortSignal, operation: () => Promise<T>): Promise<T>;
  rateLimited(retryAfterMs?: number): void;
  readImage(reference: string, signal: PluginAbortSignal): Promise<Uint8Array>;
  openVideo(
    reference: string,
    signal: PluginAbortSignal,
  ): Promise<LocalVideoResource>;
}
export interface PlatformPluginExecution {
  openDataClient?(input: {
    base: PlatformDataClient;
    account: PluginAccount;
    settings: PlatformSettings;
    host: PlatformExecutionHost;
  }): {
    dataClient: PlatformDataClient;
    close(): Promise<void>;
  };
  openPublisher?(input: {
    account: PluginAccount;
    settings: PlatformSettings;
    adapterId: string;
    host: PlatformExecutionHost;
  }): Promise<PluginPublishSession>;
}
export interface PlatformPluginEntry {
  readonly module: PlatformModule;
  readonly execution?: PlatformPluginExecution;
}
