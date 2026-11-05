import { randomUUID } from "node:crypto";

import {
  MediaSelectionUnavailableError,
  type MediaSelection,
  type StartPublicationInput,
} from "@nedia-matrix/publishing";
import type { SupportedPublishContentForm as PublishContentForm } from "@nedia-matrix/publishing";

const MEDIA_SELECTION_TTL_MS = 30 * 60_000;

interface StoredMediaSelection extends MediaSelection {
  inUse: boolean;
}

export class MediaSelectionStore {
  private readonly selections = new Map<string, StoredMediaSelection>();

  create(input: {
    accountId: string;
    contentForm: PublishContentForm;
    resourceReferences: readonly string[];
    files: StartPublicationInput["assets"];
  }): string {
    this.prune();
    const id = randomUUID();
    this.selections.set(id, {
      ...input,
      createdAt: Date.now(),
      inUse: false,
    });
    return id;
  }

  acquire(
    id: string,
    accountId: string,
    contentForm: PublishContentForm,
  ): MediaSelection {
    this.prune();
    const selection = this.selections.get(id);
    if (
      !selection ||
      selection.inUse ||
      selection.accountId !== accountId ||
      selection.contentForm !== contentForm
    ) {
      throw new MediaSelectionUnavailableError();
    }
    selection.inUse = true;
    return {
      accountId: selection.accountId,
      contentForm: selection.contentForm,
      resourceReferences: selection.resourceReferences,
      files: selection.files,
      createdAt: selection.createdAt,
    };
  }

  referencedPaths(): ReadonlySet<string> {
    this.prune();
    return new Set(
      [...this.selections.values()].flatMap(({ files }) =>
        files.flatMap(({ localRelativePath }) =>
          localRelativePath ? [localRelativePath] : [],
        ),
      ),
    );
  }

  release(id: string): void {
    const selection = this.selections.get(id);
    if (selection) selection.inUse = false;
  }

  consume(id: string): void {
    this.selections.delete(id);
  }

  removeForAccount(accountId: string): void {
    for (const [id, selection] of this.selections) {
      if (selection.accountId === accountId) this.selections.delete(id);
    }
  }

  clear(): void {
    this.selections.clear();
  }

  private prune(): void {
    const expiredBefore = Date.now() - MEDIA_SELECTION_TTL_MS;
    for (const [id, selection] of this.selections) {
      if (!selection.inUse && selection.createdAt < expiredBefore) {
        this.selections.delete(id);
      }
    }
  }
}
