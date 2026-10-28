import { RuntimeAccountAccess } from "../security/runtime-account-access.js";
import type { RuntimeAccess } from "../security/runtime-access.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { NediaMatrixUseCases } from "../../application/nedia-matrix-application.js";
import { RuntimeEventBuffer } from "../events/runtime-event-buffer.js";
import { runtimePublicationEvent } from "../mapping/runtime-publication-mapper.js";
import { writeJson } from "./http-json.js";
import { RuntimeAccountRoutes } from "./routes/account-routes.js";
import { RuntimeEventRoutes } from "./routes/event-routes.js";
import { RuntimePlatformContentRoutes } from "./routes/platform-content-routes.js";
import { RuntimePublicationRoutes } from "./routes/publication-routes.js";

export type RuntimeEvent =
  | ReturnType<typeof runtimePublicationEvent>
  | { type: "runtime.accounts.changed" }
  | {
      type: "runtime.task.changed";
      taskId: string;
      requestId: string;
      state: string;
    };

export interface LocalRuntimeHandshake {
  protocolVersion: 1;
  runtimeKind: "desktop_playwright";
  runtimeVersion: string | null;
  instanceId: string;
  supportedTargets: Array<{
    platform: string;
    contentForm: "image_text" | "video" | "long_text";
  }>;
  capabilities: {
    isolatedAccounts: boolean;
    multipleAccountsPerPlatform: boolean;
    backgroundObservation: boolean;
    localPublicationArchive: boolean;
    platformIdentityAddressing: boolean;
    platformContentSnapshots: boolean;
    platformContentSync: boolean;
    queuedPublications?: boolean;
    taskHistoryRetention?: boolean;
  };
}

export class RuntimeRouter {
  private readonly events = new RuntimeEventBuffer<RuntimeEvent>();
  private readonly accountRoutes: RuntimeAccountRoutes;
  private readonly eventRoutes: RuntimeEventRoutes<RuntimeEvent>;
  private readonly access: RuntimeAccountAccess;
  private readonly platformContentRoutes: RuntimePlatformContentRoutes;
  private readonly publicationRoutes: RuntimePublicationRoutes;

  constructor(
    private readonly application: NediaMatrixUseCases,
    private readonly handshake: LocalRuntimeHandshake,
    access?: RuntimeAccess,
  ) {
    this.access = new RuntimeAccountAccess(application, access);
    this.eventRoutes = new RuntimeEventRoutes(this.events, (event) => {
      if (event.type === "runtime.accounts.changed") return true;
      if (event.type === "runtime.task.changed") {
        const task = application.tasks?.get(event.taskId);
        return (
          !!task &&
          task.source === "runtime" &&
          this.access.allowed(task.accountId)
        );
      }
      const publication = application.publications
        .list()
        .find((item) => item.requestId === event.requestId);
      return !!publication && this.access.allowed(publication.accountId);
    });
    this.accountRoutes = new RuntimeAccountRoutes(application, this.access);
    this.platformContentRoutes = new RuntimePlatformContentRoutes(
      application,
      this.access,
    );
    this.publicationRoutes = new RuntimePublicationRoutes(
      application,
      this.access,
    );
  }

  open(): void {
    this.events.open();
  }

  close(): void {
    this.events.close();
  }

  publishPublicationUpdate(publicationId: string): void {
    const summary = this.application.publications
      .list()
      .find((publication) => publication.id === publicationId);
    if (summary) this.events.append(runtimePublicationEvent(summary));
  }

  private readonly taskRevisions = new Map<string, string>();
  publishTasksChanged(): void {
    if (!this.application.tasks) return;
    // Only active Runtime requests need events; status queries remain authoritative.
    for (let offset = 0; ; offset += 100) {
      const page = this.application.tasks.query({
        type: "publication",
        limit: 100,
        offset,
      });
      for (const task of page.items)
        if (task.source === "runtime" && task.requestId) {
          const revision = JSON.stringify([
            task.updatedAt,
            task.state,
            task.phase,
            task.publicationId,
            task.error,
          ]);
          if (this.taskRevisions.get(task.id) === revision) continue;
          this.taskRevisions.set(task.id, revision);
          this.events.append({
            type: "runtime.task.changed",
            taskId: task.id,
            requestId: task.requestId,
            state: task.state,
          });
        }
      if (offset + page.items.length >= page.total) break;
    }
  }

  publishAccountsChanged(): void {
    this.events.append({ type: "runtime.accounts.changed" });
  }

  route(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    if (request.method === "GET" && url.pathname === "/v1/runtime") {
      writeJson(response, 200, this.handshake);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      void this.eventRoutes.poll(response, url.searchParams.get("after"));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/accounts") {
      this.accountRoutes.list(response);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/platforms") {
      writeJson(response, 200, this.application.platformSummaries());
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/publications") {
      void this.publicationRoutes.create(request, response);
      return true;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/platform-content-syncs"
    ) {
      void this.platformContentRoutes.sync(request, response);
      return true;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/platform-content-snapshots/query"
    ) {
      void this.platformContentRoutes.query(request, response);
      return true;
    }

    const publicationMatch =
      /^\/v1\/publications\/([A-Za-z0-9._~-]{1,128})$/.exec(url.pathname);
    if (request.method === "GET" && publicationMatch?.[1]) {
      this.publicationRoutes.status(response, publicationMatch[1]);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/v1/accounts") {
      void this.accountRoutes.create(request, response);
      return true;
    }

    const accountMatch = /^\/v1\/accounts\/([A-Za-z0-9._~-]{1,128})$/.exec(
      url.pathname,
    );
    if (request.method === "DELETE" && accountMatch?.[1]) {
      void this.accountRoutes.remove(response, accountMatch[1]);
      return true;
    }
    const accountActionMatch =
      /^\/v1\/accounts\/([A-Za-z0-9._~-]{1,128})\/(open|refresh)$/.exec(
        url.pathname,
      );
    if (request.method === "POST" && accountActionMatch?.[1]) {
      if (accountActionMatch[2] === "open") {
        void this.accountRoutes.open(request, response, accountActionMatch[1]);
      } else {
        void this.accountRoutes.refresh(response, accountActionMatch[1]);
      }
      return true;
    }
    return false;
  }
}
