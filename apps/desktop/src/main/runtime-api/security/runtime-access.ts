import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type {
  LocalRuntimeSettings,
  UpdateLocalRuntimeSettings,
} from "../../../bridge/runtime-access.js";

export interface StoredRuntimeSettings {
  port: number;
  allowedOrigins: string[];
  password?: { salt: string; hash: string };
}

export interface RuntimeAccessStore {
  read(): StoredRuntimeSettings | undefined;
  write(settings: StoredRuntimeSettings): void;
  allowed(accountId: string): boolean;
  setAllowed(accountId: string, allowed: boolean): void;
}

export class RuntimeAccessError extends Error {
  readonly code = "ACCOUNT_NOT_AVAILABLE";
  constructor() {
    super("Account is not available for external access");
  }
}

export function writeAccessError(
  response: import("node:http").ServerResponse,
  error: unknown,
): boolean {
  if (!(error instanceof RuntimeAccessError)) return false;
  if (response.destroyed) return true;
  response.writeHead(404, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ code: error.code, message: error.message }));
  return true;
}

export class RuntimeAccess {
  private settings: StoredRuntimeSettings;
  private revision = 0;
  private attempts = 0;
  private attemptWindow = 0;
  private readonly sessions = new Map<
    string,
    { origin: string | undefined; expires: number }
  >();

  constructor(
    private readonly store: RuntimeAccessStore,
    port = 17653,
  ) {
    this.settings = store.read() ?? { port, allowedOrigins: ["*"] };
  }

  snapshot(): StoredRuntimeSettings {
    return structuredClone(this.settings);
  }
  view(): LocalRuntimeSettings {
    return {
      port: this.settings.port,
      allowedOrigins: [...this.settings.allowedOrigins],
      passwordConfigured: !!this.settings.password,
    };
  }
  async prepare(
    input: UpdateLocalRuntimeSettings,
  ): Promise<StoredRuntimeSettings> {
    if (
      !input ||
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535
    )
      throw new TypeError("端口必须是 1 至 65535 的整数");
    if (
      !Array.isArray(input.allowedOrigins) ||
      !input.allowedOrigins.length ||
      input.allowedOrigins.length > 100
    )
      throw new TypeError("请填写 * 或网站来源列表");
    const origins = [
      ...new Set(
        input.allowedOrigins.map((origin) => {
          if (typeof origin !== "string") throw new TypeError("无效的网站来源");
          if (origin === "*") return origin;
          const url = new URL(origin);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.origin !== origin
          )
            throw new TypeError("来源必须是完整的 HTTP(S) Origin，不包含路径");
          return origin;
        }),
      ),
    ];
    if (origins.includes("*") && origins.length !== 1)
      throw new TypeError("* 不能与具体来源混用");
    const next = {
      ...this.snapshot(),
      port: input.port,
      allowedOrigins: origins,
    };
    if (input.password !== undefined) {
      if (
        typeof input.password !== "string" ||
        input.password.length > 1024 ||
        (input.password !== "" && input.password.length < 12)
      )
        throw new TypeError("连接密码至少 12 个字符，最多 1024 个字符");
      if (input.password === "") delete next.password;
      else {
        const salt = randomBytes(16).toString("hex");
        next.password = {
          salt,
          hash: (await derive(input.password, salt)).toString("hex"),
        };
      }
    }
    return next;
  }
  commit(next: StoredRuntimeSettings): void {
    this.store.write(next);
    this.settings = structuredClone(next);
    this.revoke();
  }
  revoke(): void {
    this.revision++;
    this.sessions.clear();
  }
  allowsOrigin(origin: string | undefined): boolean {
    return (
      this.settings.allowedOrigins.includes("*") ||
      (origin !== undefined && this.settings.allowedOrigins.includes(origin))
    );
  }
  authorized(header: string | undefined, origin: string | undefined): boolean {
    if (!this.settings.password) return true;
    if (!header?.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return session.origin === origin;
  }
  async authenticate(
    password: unknown,
    origin: string | undefined,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const now = Date.now();
    if (now - this.attemptWindow >= 60_000) {
      this.attemptWindow = now;
      this.attempts = 0;
    }
    if (++this.attempts > 10)
      return { status: 429, body: { code: "AUTH_RATE_LIMITED" } };
    const revision = this.revision;
    const configured = this.settings.password;
    if (!configured)
      return { status: 400, body: { code: "AUTH_NOT_CONFIGURED" } };
    if (typeof password !== "string" || password.length > 1024)
      return { status: 401, body: { code: "INVALID_CREDENTIALS" } };
    const candidate = await derive(password, configured.salt);
    if (
      revision !== this.revision ||
      !timingSafeEqual(candidate, Buffer.from(configured.hash, "hex"))
    )
      return { status: 401, body: { code: "INVALID_CREDENTIALS" } };
    for (const [token, session] of this.sessions)
      if (session.expires <= now) this.sessions.delete(token);
    if (this.sessions.size >= 256)
      this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    const expires = Date.now() + 3_600_000;
    this.sessions.set(token, { origin, expires });
    return {
      status: 200,
      body: { token, expiresAt: new Date(expires).toISOString() },
    };
  }
  allowed(accountId: string): boolean {
    return this.store.allowed(accountId);
  }
  setAllowed(accountId: string, allowed: boolean): void {
    if (
      typeof accountId !== "string" ||
      !accountId ||
      typeof allowed !== "boolean"
    )
      throw new TypeError("Invalid account access setting");
    this.store.setAllowed(accountId, allowed);
  }
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
