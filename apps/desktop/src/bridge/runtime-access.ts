export interface LocalRuntimeSettings {
  port: number;
  passwordConfigured: boolean;
  allowedOrigins: string[];
}

export interface UpdateLocalRuntimeSettings {
  port: number;
  allowedOrigins: string[];
  /** Omitted: keep password. Empty string: explicitly remove password. */
  password?: string;
}

export interface RuntimeAccountAccess {
  accountId: string;
  allowed: boolean;
}
