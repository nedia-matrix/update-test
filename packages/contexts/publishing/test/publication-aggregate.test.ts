import { describe, expect, it } from "vitest";

import {
  InvalidPublicationSnapshotError,
  Publication,
  createContentRevision,
  createPublication,
  transitionPublication,
} from "../src/index.js";

const createdAt = "2026-09-10T00:00:00.000Z";

function snapshot() {
  const revision = createContentRevision({
    id: "revision-1",
    contentItemId: "publication-1",
    revision: 1,
    title: "title",
    body: "body",
    assetIds: [],
    createdAt,
  });
  const draft = createPublication({
    id: "publication-1",
    platformId: "platform-1",
    accountId: "account-1",
    contentRevisionId: revision.id,
  });
  const validated = transitionPublication(draft, "validated", createdAt);
  const preparing = transitionPublication(validated, "preparing", createdAt);
  return {
    requestId: "request-1",
    publication: preparing,
    contentRevision: revision,
    contentForm: "imageText" as const,
    tags: [],
    submissionMode: "manual_confirmation" as const,
    submissionEvidence: "none" as const,
    lastObservationSequence: 0,
    retained: false,
    assets: [],
    rulesVersion: "rules-1",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("publication aggregate", () => {
  it("allows explicit removal of cancelled and rejected tasks after execution ends", () => {
    const base = snapshot();
    const cancelled = Publication.rehydrate({
      ...base,
      publication: transitionPublication(
        base.publication,
        "cancelled",
        "2026-09-10T00:00:01.000Z",
      ),
      updatedAt: "2026-09-10T00:00:01.000Z",
    });
    expect(cancelled.canBeRemovedFromArchive()).toBe(true);
    expect(cancelled.canBeRemovedFromArchive(true)).toBe(false);

    const validated = transitionPublication(
      transitionPublication(
        createPublication({
          id: "publication-1",
          platformId: "platform-1",
          accountId: "account-1",
          contentRevisionId: base.contentRevision.id,
        }),
        "validated",
        createdAt,
      ),
      "rejected",
      "2026-09-10T00:00:01.000Z",
    );
    const rejected = Publication.rehydrate({
      ...base,
      publication: validated,
      updatedAt: "2026-09-10T00:00:01.000Z",
    });
    expect(rejected.canBeRemovedFromArchive()).toBe(true);
  });

  it("owns observation transitions and rejects mismatched identities", () => {
    const aggregate = Publication.rehydrate(snapshot());

    const submitted = aggregate.recordObservation(
      {
        kind: "submission_attempted",
        source: "page_request",
        message: "submitted",
      },
      "2026-09-10T00:00:01.000Z",
      1,
      { accountId: "account-1", platformId: "platform-1" },
    );
    expect(submitted.publication.state).toBe("submitting");
    expect(submitted.submissionEvidence).toBe("submission_attempted");

    const published = aggregate.recordObservation(
      { kind: "published", contentId: "remote-1", contentUrl: null },
      "2026-09-10T00:00:02.000Z",
      2,
    );
    expect(published.publication.state).toBe("published");
    expect(published.publication.platformContentId).toBe("remote-1");
    expect(() =>
      aggregate.recordObservation(
        { kind: "published", contentId: null, contentUrl: null },
        "2026-09-10T00:00:03.000Z",
        3,
        { accountId: "other-account", platformId: "platform-1" },
      ),
    ).toThrow("Observation reference mismatch");
  });

  it("keeps snapshots isolated and ignores stale observations", () => {
    const aggregate = Publication.rehydrate(snapshot());
    const first = aggregate.recordObservation(
      {
        kind: "submission_attempted",
        source: "application_commit",
        message: "submitted",
      },
      "2026-09-10T00:00:01.000Z",
      2,
    );
    (first.tags as string[]).push("mutated");
    const stale = aggregate.recordObservation(
      { kind: "failed", message: "stale" },
      "2026-09-10T00:00:02.000Z",
      1,
    );

    expect(stale.tags).toEqual([]);
    expect(stale.publication.state).toBe("submitting");
  });

  it("rejects inconsistent persisted state instead of trusting the shape", () => {
    const base = snapshot();

    expect(() =>
      Publication.rehydrate({
        ...base,
        publication: {
          ...base.publication,
          state: "published",
          transitions: [],
        },
      }),
    ).toThrow(InvalidPublicationSnapshotError);

    expect(() =>
      Publication.rehydrate({
        ...base,
        publication: {
          ...base.publication,
          contentRevisionId: "other-revision",
        },
      }),
    ).toThrow("content revision reference");

    expect(() =>
      Publication.rehydrate({
        ...base,
        contentRevision: {
          ...base.contentRevision,
          contentItemId: "other-publication",
        },
      }),
    ).toThrow("content item reference");

    expect(() =>
      Publication.rehydrate({
        ...base,
        contentRevision: {
          ...base.contentRevision,
          assetIds: ["missing-asset"],
        },
      }),
    ).toThrow("asset count");

    expect(() =>
      Publication.rehydrate({
        ...base,
        lastObservationSequence: -1,
      }),
    ).toThrow("observation sequence");
  });

  it.each([
    {
      name: "a broken transition chain",
      transitions: [
        {
          from: "draft" as const,
          to: "validated" as const,
          occurredAt: createdAt,
        },
        {
          from: "scheduled" as const,
          to: "preparing" as const,
          occurredAt: createdAt,
        },
      ],
    },
    {
      name: "an illegal transition",
      transitions: [
        {
          from: "draft" as const,
          to: "published" as const,
          occurredAt: createdAt,
        },
      ],
    },
    {
      name: "a reversed transition timeline",
      transitions: [
        {
          from: "draft" as const,
          to: "validated" as const,
          occurredAt: "2026-09-10T00:00:01.000Z",
        },
        {
          from: "validated" as const,
          to: "preparing" as const,
          occurredAt: createdAt,
        },
      ],
    },
  ])("rejects $name", ({ transitions }) => {
    const base = snapshot();
    expect(() =>
      Publication.rehydrate({
        ...base,
        updatedAt: "2026-09-10T00:00:02.000Z",
        publication: { ...base.publication, transitions },
      }),
    ).toThrow(InvalidPublicationSnapshotError);
  });

  it("rehydrates legal partial legacy history without inventing transitions", () => {
    const base = snapshot();
    const legacy = {
      ...base,
      submissionMode: "legacy_unknown" as const,
      submissionEvidence: "legacy_unknown" as const,
      publication: {
        ...base.publication,
        transitions: [base.publication.transitions[1]!],
      },
    };

    expect(Publication.rehydrate(legacy).toSnapshot()).toEqual(legacy);
  });

  it("rejects updates that move the publication clock backwards", () => {
    const aggregate = Publication.rehydrate(snapshot());

    expect(() =>
      aggregate.setRetained(true, "2026-09-09T23:59:59.000Z"),
    ).toThrow("cannot move backwards");
    expect(aggregate.toSnapshot().retained).toBe(false);

    expect(() =>
      aggregate.recordObservation(
        {
          kind: "submission_attempted",
          source: "page_request",
          message: "late delivery with an old clock",
        },
        "2026-09-09T23:59:59.000Z",
        1,
      ),
    ).toThrow("cannot move backwards");
    expect(aggregate.toSnapshot()).toEqual(snapshot());
  });

  it("rejects invalid incoming sequences before stale-event handling", () => {
    const aggregate = Publication.rehydrate(snapshot());
    expect(() =>
      aggregate.recordObservation(
        { kind: "verification_required", message: "invalid" },
        createdAt,
        -1,
      ),
    ).toThrow("observation sequence");
    expect(aggregate.toSnapshot()).toEqual(snapshot());
  });
});
