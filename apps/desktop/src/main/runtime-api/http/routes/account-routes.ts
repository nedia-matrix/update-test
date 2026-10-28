import { RuntimeAccountAccess } from "../../security/runtime-account-access.js";
import { writeAccessError } from "../../security/runtime-access.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { NediaMatrixUseCases } from "../../../application/nedia-matrix-application.js";
import { AccountReplacedError } from "@nedia-matrix/account-management";
import { toRuntimeAccountSession } from "../../mapping/runtime-account-mapper.js";
import { readJsonRequest, writeJson } from "../http-json.js";

export class RuntimeAccountRoutes {
  constructor(
    private readonly application: NediaMatrixUseCases,
    private readonly access = new RuntimeAccountAccess(application),
  ) {}

  list(response: ServerResponse): void {
    writeJson(
      response,
      200,
      this.application.accounts
        .list()
        .filter((account) => this.access.allowed(account.id))
        .map((account) => toRuntimeAccountSession(account)),
    );
  }

  async create(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readJsonRequest(request);
      const platformId = typeof body.platform === "string" ? body.platform : "";
      const account = this.application.accounts.create({ platformId });
      writeJson(response, 201, toRuntimeAccountSession(account));
    } catch (error) {
      this.writeActionError(response, error);
    }
  }

  async open(
    request: IncomingMessage,
    response: ServerResponse,
    runtimeAccountId: string,
  ): Promise<void> {
    try {
      this.access.byId(runtimeAccountId);
      const body = await readJsonRequest(request);
      this.access.byId(runtimeAccountId);
      const resolved = this.application.accounts.resolve({
        accountId: runtimeAccountId,
      });
      const account = resolved.account;
      if (account.status === "login_required") {
        const platform = this.application
          .platformSummaries()
          .find((candidate) => candidate.id === account.platformId);
        const requestedLoginEntryId =
          typeof body.loginEntryId === "string" ? body.loginEntryId : null;
        const loginEntryId =
          requestedLoginEntryId ?? platform?.loginEntries[0]?.id;
        if (!loginEntryId) {
          throw new TypeError("Platform does not have a login entry");
        }
        await this.application.accounts.openLogin({
          accountId: runtimeAccountId,
          loginEntryId,
        });
      } else {
        await this.application.accounts.open({ accountId: runtimeAccountId });
      }
      this.access.byId(runtimeAccountId);
      const current = this.application.accounts.resolve({
        accountId: runtimeAccountId,
      });
      writeJson(
        response,
        200,
        toRuntimeAccountSession(current.account, current.replacementAlias),
      );
    } catch (error) {
      this.writeActionError(response, error);
    }
  }

  async refresh(
    response: ServerResponse,
    runtimeAccountId: string,
  ): Promise<void> {
    try {
      this.access.byId(runtimeAccountId);
      await this.application.accounts.refresh({ accountId: runtimeAccountId });
      this.access.byId(runtimeAccountId);
      const resolved = this.application.accounts.resolve({
        accountId: runtimeAccountId,
      });
      writeJson(
        response,
        200,
        toRuntimeAccountSession(resolved.account, resolved.replacementAlias),
      );
    } catch (error) {
      this.writeActionError(response, error);
    }
  }

  async remove(
    response: ServerResponse,
    runtimeAccountId: string,
  ): Promise<void> {
    try {
      this.access.byId(runtimeAccountId);
      await this.application.accounts.remove({ accountId: runtimeAccountId });
      writeJson(response, 200, { removed: true, runtimeAccountId });
    } catch (error) {
      this.writeActionError(response, error);
    }
  }

  private writeActionError(response: ServerResponse, error: unknown): void {
    if (writeAccessError(response, error)) return;
    if (error instanceof AccountReplacedError) {
      writeJson(response, 409, {
        code: "ACCOUNT_REPLACED",
        runtimeAccountId: error.survivingAccountId,
        message: error.message,
      });
      return;
    }
    writeJson(response, 400, {
      code: "ACCOUNT_ACTION_FAILED",
      message: error instanceof Error ? error.message : "Account action failed",
    });
  }
}
