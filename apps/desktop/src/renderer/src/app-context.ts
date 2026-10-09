import type { PlatformAccountView } from "@nedia-matrix/account-management";
import type {
  PublicationAttentionResolution,
  PublicationQuery,
  PublicationQueryResult,
  PublicationTaskCounts,
  PublicationTaskSummary,
  PublishResultUpdate,
  RecreatedPublicationDraft,
} from "@nedia-matrix/publishing";
import type { PlatformSummary } from "../../bridge/contracts.js";

export type StatusKind = "idle" | "busy" | "error";

export interface AppStatus {
  message: string;
  kind: StatusKind;
}

export class AppContext {
  platforms: readonly PlatformSummary[] = [];
  accounts: readonly PlatformAccountView[] = [];
  publications: readonly PublicationTaskSummary[] = [];
  publicationTaskCounts: PublicationTaskCounts = {
    actionRequired: 0,
    openAttentionRequired: 0,
    inProgress: 0,
    completed: 0,
    completedAutomatic: 0,
    completedManual: 0,
    attentionRequired: 0,
    closed: 0,
    all: 0,
    pending: 0,
  };
  activePublicationId: string | null = null;
  recreatedDraft: RecreatedPublicationDraft | null = null;

  private readonly publishListeners = new Set<
    (update: PublishResultUpdate) => void
  >();
  private readonly recentPublishUpdates = new Map<
    string,
    PublishResultUpdate
  >();
  private readonly accountListeners = new Set<
    (accounts: readonly PlatformAccountView[]) => void
  >();
  private readonly publicationCountListeners = new Set<
    (counts: PublicationTaskCounts) => void
  >();
  private readonly statusListeners = new Set<(status: AppStatus) => void>();
  private accountRefreshRequested = false;
  private accountRefreshInFlight: Promise<void> | undefined;
  private publicationRefreshRequested = false;
  private publicationRefreshInFlight:
    Promise<readonly PublicationTaskSummary[]> | undefined;
  private status: AppStatus = { message: "准备就绪", kind: "idle" };

  constructor() {
    window.matrix.onPlatformAccountsChanged(() => {
      this.requestAccountRefresh();
    });
    window.matrix.onPublishResultUpdate((update) => {
      this.recentPublishUpdates.set(update.observationId, update);
      if (this.recentPublishUpdates.size > 20) {
        const oldestId = this.recentPublishUpdates.keys().next().value as
          string | undefined;
        if (oldestId) this.recentPublishUpdates.delete(oldestId);
      }
      for (const listener of this.publishListeners) listener(update);
      void this.refreshPublications();
    });
  }

  onAccountUpdate(
    listener: (accounts: readonly PlatformAccountView[]) => void,
  ): () => void {
    this.accountListeners.add(listener);
    return () => this.accountListeners.delete(listener);
  }

  async initialize(): Promise<void> {
    this.platforms = await window.matrix.listPlatforms();
  }

  async refreshAccounts(): Promise<readonly PlatformAccountView[]> {
    this.accounts = await window.matrix.listPlatformAccounts();
    return this.accounts;
  }

  private requestAccountRefresh(): void {
    this.accountRefreshRequested = true;
    if (this.accountRefreshInFlight) return;

    this.accountRefreshInFlight = (async () => {
      do {
        this.accountRefreshRequested = false;
        await this.refreshAccounts();
        for (const listener of this.accountListeners) listener(this.accounts);
      } while (this.accountRefreshRequested);
    })().finally(() => {
      this.accountRefreshInFlight = undefined;
    });
    void this.accountRefreshInFlight.catch(() => undefined);
  }

  refreshPublications(): Promise<readonly PublicationTaskSummary[]> {
    this.publicationRefreshRequested = true;
    if (this.publicationRefreshInFlight) return this.publicationRefreshInFlight;
    const operation = (async () => {
      do {
        this.publicationRefreshRequested = false;
        const result = await window.matrix.queryPublications({
          view: "all",
          limit: 1,
        });
        this.publications = result.items;
        this.publicationTaskCounts = result.counts;
        this.emitPublicationCounts();
      } while (this.publicationRefreshRequested);
      return this.publications;
    })().finally(() => {
      this.publicationRefreshInFlight = undefined;
    });
    this.publicationRefreshInFlight = operation;
    return operation;
  }

  async refreshPublicationTaskCounts(): Promise<PublicationTaskCounts> {
    const result = await window.matrix.queryPublications({
      view: "all",
      limit: 1,
    });
    this.publicationTaskCounts = result.counts;
    this.emitPublicationCounts();
    return result.counts;
  }

  async queryPublications(
    request: PublicationQuery,
  ): Promise<PublicationQueryResult> {
    const result = await window.matrix.queryPublications(request);
    this.publications = result.items;
    this.publicationTaskCounts = result.counts;
    this.emitPublicationCounts();
    return result;
  }

  async resolvePublicationAttention(
    publicationId: string,
    resolution: PublicationAttentionResolution,
    manualPlatformContentId?: string,
  ): Promise<PublicationTaskSummary> {
    const updated = await window.matrix.resolvePublicationAttention({
      publicationId,
      resolution,
      ...(manualPlatformContentId ? { manualPlatformContentId } : {}),
    });
    this.publications = this.publications.map((publication) =>
      publication.id === updated.id ? updated : publication,
    );
    await this.refreshPublicationTaskCounts();
    return updated;
  }

  async reopenPublicationAttention(
    publicationId: string,
  ): Promise<PublicationTaskSummary> {
    const updated = await window.matrix.reopenPublicationAttention({
      publicationId,
    });
    this.publications = this.publications.map((publication) =>
      publication.id === updated.id ? updated : publication,
    );
    await this.refreshPublicationTaskCounts();
    return updated;
  }

  onPublicationCountsUpdate(
    listener: (counts: PublicationTaskCounts) => void,
  ): () => void {
    this.publicationCountListeners.add(listener);
    return () => this.publicationCountListeners.delete(listener);
  }

  private emitPublicationCounts(): void {
    for (const listener of this.publicationCountListeners)
      listener(this.publicationTaskCounts);
  }

  setStatus(message: string, kind: StatusKind = "idle"): void {
    this.status = { message, kind };
    for (const listener of this.statusListeners) listener(this.status);
  }

  setActivePublicationId(publicationId: string | null): void {
    this.activePublicationId = publicationId;
  }

  setRecreatedDraft(draft: RecreatedPublicationDraft | null): void {
    this.recreatedDraft = draft;
  }

  currentStatus(): AppStatus {
    return this.status;
  }

  onStatusUpdate(listener: (status: AppStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onPublishUpdate(listener: (update: PublishResultUpdate) => void): () => void {
    this.publishListeners.add(listener);
    return () => this.publishListeners.delete(listener);
  }

  recentPublishUpdate(observationId: string): PublishResultUpdate | undefined {
    return this.recentPublishUpdates.get(observationId);
  }
}
