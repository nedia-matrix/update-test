import { resolveAccountPlatform } from "@nedia-matrix/platform-sdk";
import type { PublishContentForm } from "../domain/index.js";

import type {
  MediaSelectionPort,
  PlatformCatalog,
  PublicationAccountReader,
} from "./ports.js";
import { isContentForm } from "./publish-request-validator.js";

export interface LocalMediaResource {
  reference: string;
  name: string;
  size: number;
  extension: string;
  mediaType?: string;
  hash?: string;
  localRelativePath?: string;
}

export interface RegisterLocalMediaCommand {
  accountId: string;
  contentForm: PublishContentForm;
  resources: readonly LocalMediaResource[];
}

export type RegisterLocalMediaResult =
  | { status: "login_required" }
  | {
      status: "selected";
      selectionId: string;
      files: readonly { name: string; size: number }[];
    };

interface LocalMediaDependencies {
  accounts: PublicationAccountReader;
  mediaSelections: MediaSelectionPort;
  platforms: PlatformCatalog;
}

export function registerLocalMedia(
  command: RegisterLocalMediaCommand,
  dependencies: LocalMediaDependencies,
): RegisterLocalMediaResult {
  assertAccountId(command.accountId);
  if (!isContentForm(command.contentForm)) {
    throw new TypeError("Invalid publish content form");
  }
  const account = dependencies.accounts.require(command.accountId);
  if (account.lifecycle !== "active" || account.status === "login_required") {
    return { status: "login_required" };
  }

  const platform = resolveAccountPlatform(dependencies.platforms, account);
  const form = platform.publishing?.forms[command.contentForm];
  if (!form) {
    throw new TypeError(
      `${platform.displayName} does not support ${command.contentForm}`,
    );
  }

  const maxMediaCount = form.constraints.mediaMaxCount;
  if (command.resources.length === 0) {
    throw new TypeError("A draft must contain at least one media file");
  }
  if (maxMediaCount !== undefined && command.resources.length > maxMediaCount) {
    throw new TypeError(
      `A draft can contain at most ${maxMediaCount} media files`,
    );
  }

  const allowedExtensions =
    command.contentForm === "video"
      ? new Set([".mp4", ".mov", ".m4v", ".webm"])
      : new Set([".jpg", ".jpeg", ".png", ".webp"]);
  if (
    command.resources.some(
      ({ extension }) => !allowedExtensions.has(extension.toLowerCase()),
    )
  ) {
    throw new TypeError("Selected media format is not supported");
  }
  if (
    command.resources.some(
      ({ reference, name, size }) =>
        reference.length === 0 ||
        name.length === 0 ||
        !Number.isSafeInteger(size) ||
        size < 0,
    )
  ) {
    throw new TypeError("Invalid local media resource");
  }

  const files = command.resources.map(
    ({ name, size, mediaType, hash, localRelativePath }) => ({
      name,
      size,
      ...(mediaType ? { mediaType } : {}),
      ...(hash ? { hash } : {}),
      ...(localRelativePath ? { localRelativePath } : {}),
    }),
  );
  const selectionId = dependencies.mediaSelections.create({
    accountId: account.id,
    contentForm: command.contentForm,
    resourceReferences: command.resources.map(({ reference }) => reference),
    files,
  });
  return { status: "selected", selectionId, files };
}

function assertAccountId(accountId: string): void {
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new TypeError("Invalid account request");
  }
}
