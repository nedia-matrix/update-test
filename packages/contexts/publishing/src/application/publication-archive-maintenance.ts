import type {
  PublicationArchiveAssetStore,
  PublicationArchiveRepository,
  StoredPublicationAsset,
} from "./ports.js";
import { Publication } from "../domain/index.js";
import type { PublicationSnapshot } from "./index.js";

export interface PublicationArchiveUsage {
  assetCount: number;
  publicationCount: number;
  referencedBytes: number;
  retainedPublicationCount: number;
  totalBytes: number;
  unreferencedBytes: number;
}

export interface PublicationArchiveCleanupPolicy {
  maxBytes?: number;
  retentionBefore?: Date;
}

export interface PublicationArchiveCleanupResult {
  remainingBytes: number;
  removedAssetCount: number;
  removedPublicationIds: string[];
  reclaimedBytes: number;
  failedAssetCount?: number;
}

export class PublicationArchiveMaintenance {
  private operationTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly publications: PublicationArchiveRepository,
    private readonly assets: PublicationArchiveAssetStore,
    private readonly activity: {
      hasActiveTask(publicationId: string): boolean;
      hasActiveAssetUsers?(): boolean;
      now(): Date;
    } = {
      hasActiveTask: () => false,
      now: () => new Date(),
    },
    private readonly diagnostics?: {
      report(input: {
        event: string;
        details: Readonly<Record<string, unknown>>;
      }): void;
    },
  ) {}

  async usage(): Promise<PublicationArchiveUsage> {
    const publications = this.publications.list();
    const assets = await this.assets.list();
    const referencedPaths = publicationAssetPaths(publications);
    const referencedBytes = sumAssetBytes(assets, referencedPaths);
    const totalBytes = sumAssetBytes(assets);
    return {
      assetCount: assets.length,
      publicationCount: publications.length,
      referencedBytes,
      retainedPublicationCount: publications.filter(({ retained }) => retained)
        .length,
      totalBytes,
      unreferencedBytes: totalBytes - referencedBytes,
    };
  }

  setRetained(publicationId: string, retained: boolean): PublicationSnapshot {
    const record = this.requirePublication(publicationId);
    const updated = Publication.rehydrate(record).setRetained(
      retained,
      this.activity.now().toISOString(),
    );
    this.publications.save(updated);
    return updated;
  }

  async removePublication(
    publicationId: string,
  ): Promise<PublicationArchiveCleanupResult> {
    return this.serialize(async () => {
      const record = this.requirePublication(publicationId);
      if (
        !Publication.rehydrate(record).canBeRemovedFromArchive(
          this.activity.hasActiveTask(publicationId),
        )
      ) {
        throw new TypeError("An active publication archive cannot be removed");
      }
      const removedPaths = publicationAssetPaths([record]);
      this.publications.remove(publicationId);
      return this.removeUnreferencedAssets(
        [publicationId],
        undefined,
        undefined,
        removedPaths,
      );
    });
  }

  async cleanup(
    policy: PublicationArchiveCleanupPolicy,
  ): Promise<PublicationArchiveCleanupResult> {
    return this.serialize(async () => {
      validatePolicy(policy);
      const initialAssets = await this.assets.list();
      const initialBytes = sumAssetBytes(initialAssets);
      const removedPublicationIds: string[] = [];
      let remaining = this.publications.list();
      const candidates = remaining
        .filter((record) =>
          Publication.rehydrate(record).canBeAutomaticallyCleanedFromArchive(
            this.activity.hasActiveTask(record.publication.id),
          ),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

      for (const candidate of candidates) {
        const current = this.publications.get(candidate.publication.id);
        if (
          !current ||
          !Publication.rehydrate(current).canBeAutomaticallyCleanedFromArchive(
            this.activity.hasActiveTask(candidate.publication.id),
          )
        )
          continue;
        const expired =
          policy.retentionBefore !== undefined &&
          current.createdAt < policy.retentionBefore.toISOString();
        const overQuota =
          policy.maxBytes !== undefined &&
          sumAssetBytes(initialAssets, publicationAssetPaths(remaining)) >
            policy.maxBytes;
        if (!expired && !overQuota) continue;
        this.publications.remove(candidate.publication.id);
        removedPublicationIds.push(candidate.publication.id);
        remaining = remaining.filter(
          (record) => record.publication.id !== candidate.publication.id,
        );
      }
      return this.removeUnreferencedAssets(
        removedPublicationIds,
        initialAssets,
        initialBytes,
      );
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async removeUnreferencedAssets(
    removedPublicationIds: string[],
    inventory?: StoredPublicationAsset[],
    initialBytes?: number,
    candidatePaths?: ReadonlySet<string>,
  ): Promise<PublicationArchiveCleanupResult> {
    const assets = inventory ?? (await this.assets.list());
    const beforeBytes = initialBytes ?? sumAssetBytes(assets);
    const referencedPaths = publicationAssetPaths(this.publications.list());
    const unreferenced = this.activity.hasActiveAssetUsers?.()
      ? []
      : assets.filter(
          ({ relativePath }) =>
            !referencedPaths.has(relativePath) &&
            (candidatePaths === undefined || candidatePaths.has(relativePath)),
        );
    const outcomes = await Promise.allSettled(
      unreferenced.map(({ relativePath }) => this.assets.remove(relativePath)),
    );
    const remainingAssets = await this.assets.list();
    const remainingPaths = new Set(
      remainingAssets.map(({ relativePath }) => relativePath),
    );
    const removedAssetCount = unreferenced.filter(
      ({ relativePath }) => !remainingPaths.has(relativePath),
    ).length;
    const reclaimedBytes = Math.max(
      0,
      beforeBytes - sumAssetBytes(remainingAssets),
    );
    const failedAssetCount = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    ).length;
    if (failedAssetCount > 0) {
      try {
        this.diagnostics?.report({
          event: "publication.archive.asset_cleanup_failed",
          details: { failedAssetCount, removedPublicationIds },
        });
      } catch {
        // Diagnostic failure must not obscure a committed partial cleanup.
      }
    }
    return {
      remainingBytes: sumAssetBytes(remainingAssets),
      removedAssetCount,
      removedPublicationIds,
      reclaimedBytes,
      ...(failedAssetCount > 0 ? { failedAssetCount } : {}),
    };
  }

  private requirePublication(publicationId: string): PublicationSnapshot {
    const record = this.publications.get(publicationId);
    if (!record) throw new TypeError("Publication does not exist");
    return record;
  }
}

function publicationAssetPaths(
  publications: readonly PublicationSnapshot[],
): Set<string> {
  return new Set(
    publications.flatMap(({ assets }) =>
      assets.flatMap(({ localRelativePath }) =>
        localRelativePath === null ? [] : [localRelativePath],
      ),
    ),
  );
}

function sumAssetBytes(
  assets: readonly StoredPublicationAsset[],
  includedPaths?: ReadonlySet<string>,
): number {
  return assets.reduce(
    (total, asset) =>
      includedPaths === undefined || includedPaths.has(asset.relativePath)
        ? total + asset.size
        : total,
    0,
  );
}

function validatePolicy(policy: PublicationArchiveCleanupPolicy): void {
  if (
    policy.maxBytes !== undefined &&
    (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 0)
  ) {
    throw new TypeError("Archive maxBytes must be a non-negative safe integer");
  }
  if (
    policy.retentionBefore !== undefined &&
    !Number.isFinite(policy.retentionBefore.getTime())
  ) {
    throw new TypeError("Archive retentionBefore must be a valid date");
  }
}
