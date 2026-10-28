import type { UpdateLocalRuntimeSettings } from "../../../bridge/runtime-access.js";
import type { RuntimeAccess } from "../security/runtime-access.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { LocalRuntimeStatus } from "../../../bridge/contracts.js";
import type { DiagnosticTraceService } from "@nedia-matrix/diagnostics";
import { randomUUID } from "node:crypto";

import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";
import { readJsonRequest, writeJson } from "./http-json.js";
import { RuntimeRouter, type LocalRuntimeHandshake } from "./runtime-router.js";

const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_LOCAL_RUNTIME_PORT = 17_653;
export type { LocalRuntimeHandshake };

interface LocalRuntimeHttpServerOptions {
  application: NediaMatrixUseCases;
  handshake: LocalRuntimeHandshake;
  port?: number;
  access?: RuntimeAccess;
  diagnostics?: Pick<DiagnosticTraceService, "start">;
}

export function readLocalRuntimePort(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_LOCAL_RUNTIME_PORT;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(
      "MATRIX_RUNTIME_PORT must be an integer from 0 to 65535",
    );
  }
  return port;
}

export class LocalRuntimeHttpServer {
  private configuredPort: number;
  private boundPort: number | null = null;
  private lifecycle = Promise.resolve();
  private readonly router: RuntimeRouter;
  private readonly server = createServer((request, response) => {
    this.handle(request, response);
  });

  constructor(private readonly options: LocalRuntimeHttpServerOptions) {
    this.configuredPort =
      options.access?.view().port ?? options.port ?? DEFAULT_LOCAL_RUNTIME_PORT;
    this.router = new RuntimeRouter(
      options.application,
      options.handshake,
      options.access,
    );
  }

  updateSettings(input: UpdateLocalRuntimeSettings): Promise<void> {
    return this.enqueueLifecycleOperation(async () => {
      const access = this.options.access;
      if (!access) throw new Error("Runtime access settings unavailable");
      const next = await access.prepare(input);
      const previousPort = this.boundPort ?? this.configuredPort;
      const running = this.boundPort !== null;
      await this.stopListening();
      this.configuredPort = next.port;
      try {
        if (running) await this.startListening();
        access.commit(next);
      } catch (error) {
        await this.stopListening();
        this.configuredPort = previousPort;
        if (running) await this.startListening();
        throw error;
      }
    });
  }

  start(): Promise<number> {
    return this.enqueueLifecycleOperation(() => this.startListening());
  }

  stop(): Promise<void> {
    return this.enqueueLifecycleOperation(() => this.stopListening());
  }

  status(): LocalRuntimeStatus {
    return {
      status: this.boundPort === null ? "stopped" : "running",
      version: this.options.handshake.runtimeVersion,
      host: LOOPBACK_HOST,
      port: this.boundPort,
    };
  }

  publishPublicationUpdate(publicationId: string): void {
    this.router.publishPublicationUpdate(publicationId);
  }

  publishTasksChanged(): void {
    this.router.publishTasksChanged();
  }

  publishAccountsChanged(): void {
    this.router.publishAccountsChanged();
  }

  private async startListening(): Promise<number> {
    if (this.boundPort !== null) return this.boundPort;

    this.router.open();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.configuredPort, LOOPBACK_HOST, () => {
        this.server.off("error", onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local runtime server did not expose a TCP address");
    }
    this.boundPort = address.port;
    return address.port;
  }

  private async stopListening(): Promise<void> {
    if (!this.server.listening) {
      this.router.close();
      this.boundPort = null;
      return;
    }
    const stopped = new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.options.access?.revoke();
    this.router.close();
    this.server.closeAllConnections();
    await stopped;
    this.boundPort = null;
  }

  private enqueueLifecycleOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const startedAt = Date.now();
    let rejectionCode: string | undefined;
    this.observeResponse(request, response, startedAt, () => rejectionCode);
    if (!this.hasValidHost(request)) {
      rejectionCode = "INVALID_HOST";
      writeJson(response, 400, { code: "INVALID_HOST" });
      return;
    }

    const origin = request.headers.origin;
    if (this.options.access && !this.options.access.allowsOrigin(origin)) {
      rejectionCode = "ORIGIN_NOT_ALLOWED";
      writeJson(response, 403, { code: rejectionCode });
      return;
    }
    const wildcard =
      !this.options.access ||
      this.options.access.view().allowedOrigins.includes("*");
    response.setHeader("Access-Control-Allow-Origin", wildcard ? "*" : origin!);
    if (!wildcard) response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      response.setHeader(
        "Access-Control-Allow-Methods",
        "DELETE, GET, POST, PUT, OPTIONS",
      );
      if (
        request.headers["access-control-request-private-network"] === "true"
      ) {
        response.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (
      request.method === "POST" &&
      url.pathname === "/v1/auth/session" &&
      this.options.access
    ) {
      void this.authenticate(request, response);
      return;
    }
    if (
      this.options.access &&
      !this.options.access.authorized(request.headers.authorization, origin)
    ) {
      rejectionCode = "SESSION_INVALID";
      writeJson(response, 401, { code: rejectionCode });
      return;
    }
    if (!this.router.route(request, response, url)) {
      writeJson(response, 404, { code: "NOT_FOUND" });
    }
  }

  private async authenticate(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readJsonRequest(request);
      const result = await this.options.access!.authenticate(
        body.password,
        request.headers.origin,
      );
      if (response.destroyed) return;
      if (result.status === 429) response.setHeader("Retry-After", "60");
      writeJson(response, result.status, result.body);
    } catch {
      if (!response.destroyed)
        writeJson(response, 400, { code: "INVALID_REQUEST" });
    }
  }

  private observeResponse(
    request: IncomingMessage,
    response: ServerResponse,
    startedAt: number,
    rejectionCode: () => string | undefined,
  ): void {
    let completed = false;
    const finish = (aborted: boolean) => {
      if (completed) return;
      completed = true;
      const durationMs = Date.now() - startedAt;
      const route = normalizeRuntimeRoute(request.url);
      if (
        !aborted &&
        response.statusCode < 400 &&
        (route === "/v1/events" || durationMs < 5_000)
      )
        return;
      const trace = this.options.diagnostics?.start({
        operation: "runtime.request",
        requestId: randomUUID(),
      });
      const outcome =
        aborted || response.statusCode >= 500
          ? "failed"
          : response.statusCode >= 400
            ? "rejected"
            : "completed";
      trace?.report({
        component: "runtime",
        event: aborted
          ? "runtime.request.connection_aborted"
          : "runtime.request.completed",
        level: aborted || response.statusCode >= 500 ? "error" : "info",
        details: {
          ...(aborted
            ? { code: "RUNTIME_CONNECTION_ABORTED", retryable: true }
            : rejectionCode()
              ? { code: rejectionCode(), retryable: false }
              : {}),
          method: request.method ?? "UNKNOWN",
          route,
          statusCode: response.statusCode,
          durationMs,
        },
      });
      trace?.finish({ outcome });
    };
    response.once("finish", () => finish(false));
    response.once("close", () => finish(!response.writableFinished));
  }

  private hasValidHost(request: IncomingMessage): boolean {
    if (this.boundPort === null || !request.headers.host) return false;
    return request.headers.host === `${LOOPBACK_HOST}:${this.boundPort}`;
  }
}

function normalizeRuntimeRoute(value: string | undefined): string {
  const pathname = (value ?? "/").split(/[?#]/, 1)[0] ?? "/";
  return pathname
    .replace(
      /^\/v1\/publications\/[A-Za-z0-9._~-]{1,128}$/,
      "/v1/publications/:publicationId",
    )
    .replace(
      /^\/v1\/accounts\/[A-Za-z0-9._~-]{1,128}(?=\/|$)/,
      "/v1/accounts/:accountId",
    );
}
