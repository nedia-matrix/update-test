import { RuntimeAccountAccess } from "../../security/runtime-account-access.js";
import { writeAccessError } from "../../security/runtime-access.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PublishTagLimitError } from "@nedia-matrix/platform-sdk";

import type { NediaMatrixUseCases } from "../../../application/nedia-matrix-application.js";
import {
  parseRuntimePublicationRequest,
  runtimePublicationStatus,
} from "../../mapping/runtime-publication-mapper.js";
import { readJsonRequest, writeJson } from "../http-json.js";

export class RuntimePublicationRoutes {
  constructor(
    private readonly application: NediaMatrixUseCases,
    private readonly access = new RuntimeAccountAccess(application),
  ) {}

  async create(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const input = parseRuntimePublicationRequest(
        await readJsonRequest(request),
      );
      this.access.byIdentity(input.platform, input.externalAccountId);
      if (this.application.publications.wasDeleted?.(input.requestId)) {
        writeJson(response, 409, {
          code: "PUBLICATION_DELETED",
          message:
            "Publication request was deleted locally and cannot be replayed",
        });
        return;
      }
      if (this.application.tasks) {
        const prior = this.application.publications
          .list()
          .find((item) => item.requestId === input.requestId);
        if (prior) {
          this.access.assert(prior.accountId);
          writeJson(response, 202, runtimePublicationStatus(prior));
          return;
        }
        const account = this.application.accounts.resolveByExternalIdentity({
          platformId: input.platform,
          externalAccountId: input.externalAccountId,
        });
        this.access.assert(account.id);
        const existingTask = this.application.tasks.byRequest(input.requestId);
        if (existingTask && existingTask.accountId !== account.id)
          throw new TypeError("request ID 已用于另一个账号");
        if (existingTask?.historyCleared) {
          this.status(response, input.requestId, 202);
          return;
        }
        await this.application.publications.prepareRemote({
          accountId: account.id,
          requestId: input.requestId,
          contentForm: input.contentForm,
          title: input.title,
          body: input.body,
          tags: input.tags,
          assets: input.assets,
        });
        this.access.assert(account.id);
        this.status(response, input.requestId, 202);
        return;
      }
      const existing = this.application.publications
        .list()
        .find((publication) => publication.requestId === input.requestId);
      if (existing) {
        this.access.assert(existing.accountId);
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
      this.access.assert(account.id);
      const result = await this.application.publications.prepareRemote({
        accountId: account.id,
        requestId: input.requestId,
        contentForm: input.contentForm,
        title: input.title,
        body: input.body,
        tags: input.tags,
        assets: input.assets,
      });
      this.access.assert(account.id);
      if (result.status === "cancelled") {
        writeJson(response, 200, {
          requestId: input.requestId,
          state: "cancelled",
          result: {
            platform: input.platform,
            contentForm:
              input.contentForm === "imageText" ? "image_text" : "video",
            state: "cancelled",
            ok: false,
            error: result.message,
            errorCode: "publish_cancelled",
            retryable: true,
          },
        });
        return;
      }
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
      if (writeAccessError(response, error)) return;
      const identityError =
        error instanceof Error &&
        [
          "ACCOUNT_NOT_FOUND",
          "ACCOUNT_AMBIGUOUS",
          "NOT_LOGGED_IN",
          "ACCOUNT_IDENTITY_MISMATCH",
        ].includes((error as Error & { code?: string }).code ?? "");
      const invalidRequest =
        error instanceof TypeError || error instanceof PublishTagLimitError;
      const status = identityError ? 409 : invalidRequest ? 400 : 500;
      writeJson(response, status, {
        code: identityError
          ? (error as Error & { code: string }).code
          : invalidRequest
            ? "INVALID_REQUEST"
            : "PUBLISH_FAILED",
        message: error instanceof Error ? error.message : "Publish failed",
      });
    }
  }

  status(response: ServerResponse, requestId: string, statusCode = 200): void {
    const task = this.application.tasks?.byRequest(requestId);
    if (task) {
      try {
        this.access.assert(task.accountId);
      } catch (error) {
        if (writeAccessError(response, error)) return;
        throw error;
      }
      if (this.application.publications.wasDeleted?.(requestId)) {
        writeJson(response, statusCode, { requestId, state: "deleted" });
        return;
      }
      const publication = this.application.publications
        .list()
        .find((item) => item.requestId === requestId);
      writeJson(
        response,
        statusCode,
        publication
          ? { ...runtimePublicationStatus(publication), taskId: task.id }
          : {
              requestId,
              taskId: task.id,
              ...(task.historyCleared
                ? { historyCleared: true, replayable: false }
                : {}),
              state: task.state === "retry_wait" ? "queued" : task.state,
              task: {
                state: task.state,
                phase: task.phase,
                waitReason: task.waitReason,
                error: task.error,
              },
            },
      );
      return;
    }
    const summary = this.application.publications
      .list()
      .find((publication) => publication.requestId === requestId);
    try {
      if (summary) this.access.assert(summary.accountId);
    } catch (error) {
      if (writeAccessError(response, error)) return;
      throw error;
    }
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
