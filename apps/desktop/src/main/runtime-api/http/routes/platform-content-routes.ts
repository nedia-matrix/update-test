import { RuntimeAccountAccess } from "../../security/runtime-account-access.js";
import { writeAccessError } from "../../security/runtime-access.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { PlatformAccountIdentityError } from "@nedia-matrix/account-management";
import type { NediaMatrixUseCases } from "../../../application/nedia-matrix-application.js";
import {
  parseRuntimePlatformContentQuery,
  parseRuntimePlatformContentSyncRequest,
  runtimePlatformContentQueryResult,
  runtimePlatformContentSyncResult,
} from "../../mapping/runtime-platform-content-mapper.js";
import { readJsonRequest, writeJson } from "../http-json.js";

export class RuntimePlatformContentRoutes {
  constructor(
    private readonly application: NediaMatrixUseCases,
    private readonly access = new RuntimeAccountAccess(application),
  ) {}

  async sync(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const target = parseRuntimePlatformContentSyncRequest(
        await readJsonRequest(request),
      );
      this.access.byIdentity(target.platform, target.externalAccountId);
      const run =
        await this.application.platformContents.refreshByExternalIdentity({
          platformId: target.platform,
          externalAccountId: target.externalAccountId,
        });
      this.access.byIdentity(target.platform, target.externalAccountId);
      writeJson(response, 200, runtimePlatformContentSyncResult(target, run));
    } catch (error) {
      this.writeError(response, error);
    }
  }

  async query(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const query = parseRuntimePlatformContentQuery(
        await readJsonRequest(request),
      );
      this.access.byIdentity(
        query.target.platform,
        query.target.externalAccountId,
      );
      const result = this.application.platformContents.queryByExternalIdentity({
        platformId: query.target.platform,
        externalAccountId: query.target.externalAccountId,
        externalContentIds: query.externalContentIds,
      });
      writeJson(
        response,
        200,
        runtimePlatformContentQueryResult(query, result),
      );
    } catch (error) {
      this.writeError(response, error);
    }
  }

  private writeError(response: ServerResponse, error: unknown): void {
    if (writeAccessError(response, error)) return;
    if (error instanceof PlatformAccountIdentityError) {
      writeJson(response, error.code === "ACCOUNT_NOT_FOUND" ? 404 : 409, {
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      writeJson(response, 400, {
        code: "INVALID_REQUEST",
        message: error.message,
      });
      return;
    }
    writeJson(response, 500, {
      code: "PLATFORM_CONTENT_ACTION_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "Platform content action failed",
    });
  }
}
