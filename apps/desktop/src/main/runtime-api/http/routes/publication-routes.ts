import type { IncomingMessage, ServerResponse } from "node:http";

import type { NediaMatrixUseCases } from "../../../application/nedia-matrix-application.js";
import {
  parseRuntimePublicationRequest,
  runtimePublicationStatus,
} from "../../mapping/runtime-publication-mapper.js";
import { readJsonRequest, writeJson } from "../http-json.js";

export class RuntimePublicationRoutes {
  constructor(private readonly application: NediaMatrixUseCases) {}

  async create(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const input = parseRuntimePublicationRequest(
        await readJsonRequest(request),
      );
      if (this.application.publications.wasDeleted?.(input.requestId)) {
        writeJson(response, 409, {
          code: "PUBLICATION_DELETED",
          message:
            "Publication request was deleted locally and cannot be replayed",
        });
        return;
      }
      const existing = this.application.publications
        .list()
        .find((publication) => publication.requestId === input.requestId);
      if (existing) {
        writeJson(response, 202, runtimePublicationStatus(existing));
        return;
      }
      const account = await this.application.accounts.verifyByExternalIdentity({
        platformId: input.platform,
        externalAccountId: input.externalAccountId,
      });
      if (this.application.publications.wasDeleted?.(input.requestId)) {
        writeJson(response, 409, {
          code: "PUBLICATION_DELETED",
          message:
            "Publication request was deleted locally and cannot be replayed",
        });
        return;
      }
      const result = await this.application.publications.prepareRemote({
        accountId: account.id,
        requestId: input.requestId,
        contentForm: input.contentForm,
        title: input.title,
        body: input.body,
        tags: input.tags,
        assets: input.assets,
      });
      if (result.status === "login_required") {
        writeJson(response, 409, {
          code: "NOT_LOGGED_IN",
          message: "Runtime account is not logged in",
        });
        return;
      }
      if (result.status === "account_unknown") {
        writeJson(response, 409, {
          code: "ACCOUNT_IDENTITY_MISMATCH",
          message: result.reason,
        });
        return;
      }
      if (result.status === "account_busy") {
        writeJson(response, 409, {
          code: "ACCOUNT_BUSY",
          message: "Runtime account already has an active publication",
        });
        return;
      }
      const summary = this.application.publications
        .list()
        .find((publication) => publication.requestId === input.requestId);
      if (
        !summary &&
        (result.status === "failed" || result.status === "uncertain")
      ) {
        throw new Error(result.message);
      }
      if (!summary) throw new Error("Publication was not persisted");
      writeJson(response, 202, runtimePublicationStatus(summary));
    } catch (error) {
      const identityError =
        error instanceof Error &&
        [
          "ACCOUNT_NOT_FOUND",
          "ACCOUNT_AMBIGUOUS",
          "NOT_LOGGED_IN",
          "ACCOUNT_IDENTITY_MISMATCH",
        ].includes((error as Error & { code?: string }).code ?? "");
      const status = identityError
        ? 409
        : error instanceof TypeError
          ? 400
          : 500;
      writeJson(response, status, {
        code: identityError
          ? (error as Error & { code: string }).code
          : error instanceof TypeError
            ? "INVALID_REQUEST"
            : "PUBLISH_FAILED",
        message: error instanceof Error ? error.message : "Publish failed",
      });
    }
  }

  status(response: ServerResponse, requestId: string): void {
    const summary = this.application.publications
      .list()
      .find((publication) => publication.requestId === requestId);
    writeJson(
      response,
      200,
      summary
        ? runtimePublicationStatus(summary)
        : {
            requestId,
            state: this.application.publications.wasDeleted?.(requestId)
              ? "deleted"
              : "missing",
          },
    );
  }
}
