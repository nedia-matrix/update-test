import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  PublishingService,
  PublicationService,
  type PublicationSnapshot,
} from "@nedia-matrix/publishing";
import { openDesktopMetadata } from "../src/main/persistence/open-desktop-metadata.js";
import { DesktopMetadataDatabase } from "../src/main/persistence/desktop-metadata-database.js";
import {
  importLegacyStores,
  legacySources,
} from "../src/main/persistence/legacy-store-import.js";
import { PublicationObservationQueue } from "../src/main/publishing/observations/publication-observation-queue.js";
import type { PublishObservationEvent } from "../src/main/publishing/observations/publish-observation-manager.js";

const roots: string[] = [];
const databases: { close(): void }[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "matrix-metadata-test-"));
  roots.push(root);
  return root;
}
function open(root = directory()) {
  const metadata = openDesktopMetadata(root);
  databases.push(metadata.database);
  return metadata;
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const account = {
  id: "account-1",
  platformId: "douyin",
  profileId: "matrix-douyin-account-1",
  lifecycle: "active" as const,
  displayName: "Test",
  identityScheme: null,
  externalAccountId: "external-1",
  nickname: null,
  avatarUrl: null,
  accountInfo: [],
  profileSyncedAt: null,
  status: "authenticated" as const,
  lastVerifiedAt: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};
function publishing(metadata: ReturnType<typeof open>) {
  let next = 0;
  return new PublishingService(
    metadata.publications,
    { now: () => new Date(account.createdAt) },
    { create: () => `id-${++next}` },
  );
}
function publication(service: PublishingService, requestId = "request-1") {
  return service.startPreparation({
    requestId,
    accountId: account.id,
    platformId: account.platformId,
    contentForm: "video",
    title: "Test",
    body: "Synthetic",
    assets: [],
    rulesVersion: "1",
    qualification: {
      capability: {
        constraints: {},
        submissionModes: ["automatic", "manual_confirmation"],
      },
    },
  }).record;
}
function eventFor(record: PublicationSnapshot): PublishObservationEvent {
  return {
    eventId: "event-1",
    observationId: "observation-1",
    publicationId: record.publication.id,
    accountId: account.id,
    platformId: account.platformId,
    sequence: 1,
    result: { kind: "published", contentId: null, contentUrl: null },
  };
}
function seed(root: string, records: unknown[]) {
  writeFileSync(
    join(root, `${legacySources[0]}.json`),
    JSON.stringify({
      state: {
        schemaVersion: 1,
        accounts: [account],
        replacementAliases: [],
        retiredProfiles: [],
      },
    }),
  );
  writeFileSync(
    join(root, `${legacySources[1]}.json`),
    JSON.stringify({ schemaVersion: 5, publications: records }),
  );
}

describe("SQLite desktop metadata", () => {
  it.each([false, true])(
    "recovers process termination with committed=%s",
    (committed) => {
      const root = directory();
      const metadata = open(root);
      const record = publication(publishing(metadata));
      const event = eventFor(record);
      metadata.inbox.append(event);
      metadata.database.close();
      const child = spawnSync(process.execPath, [
        "-e",
        `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const row = db.prepare('SELECT record FROM publications WHERE id=?').get(process.argv[2]);
      const record = JSON.parse(row.record); record.lastObservationSequence = 1;
      db.prepare('UPDATE publications SET record=? WHERE id=?').run(JSON.stringify(record), process.argv[2]);
      db.exec('DELETE FROM publication_observation_inbox');
      if (process.argv[3] === 'true') db.exec('COMMIT');
      process.kill(process.pid, 'SIGKILL');
    `,
        join(root, "matrix-metadata.sqlite"),
        record.publication.id,
        String(committed),
      ]);
      expect(child.signal).toBe("SIGKILL");
      const restarted = open(root);
      expect(
        restarted.publications.get(record.publication.id)
          ?.lastObservationSequence,
      ).toBe(committed ? 1 : 0);
      expect(restarted.inbox.list()).toHaveLength(committed ? 0 : 1);
    },
  );

  it("restores a verified snapshot into a separate stopped data directory", () => {
    const root = directory();
    const metadata = open(root);
    metadata.accounts.put(account);
    const before = publication(publishing(metadata));
    const restoreRoot = directory();
    metadata.database.backup(join(restoreRoot, "matrix-metadata.sqlite"));
    metadata.publications.save({ ...before, retained: true });
    metadata.database.close();
    const restored = open(restoreRoot);
    expect(restored.publications.get(before.publication.id)).toEqual(before);
    expect(restored.accounts.get(account.id)).toEqual(account);
  });

  it("normalizes account records written before profile sync metadata existed", () => {
    const root = directory();
    const metadata = open(root);
    metadata.accounts.put(account);
    const stored = metadata.database.connection
      .prepare("SELECT record FROM platform_accounts WHERE id=?")
      .get(account.id);
    const legacyAccount = JSON.parse(String(stored?.record)) as Record<
      string,
      unknown
    >;
    delete legacyAccount.profileSyncedAt;
    metadata.database.connection
      .prepare("UPDATE platform_accounts SET record=? WHERE id=?")
      .run(JSON.stringify(legacyAccount), account.id);
    metadata.database.close();

    const restarted = open(root);
    expect(restarted.accounts.get(account.id)).toEqual(account);
  });

  it.each([undefined, 1, 2, 3, 4, 5])(
    "imports supported publication schema %s and legal missing historical accounts",
    (version) => {
      const source = open();
      const record = publication(publishing(source));
      const root = directory();
      writeFileSync(
        join(root, `${legacySources[1]}.json`),
        JSON.stringify({ schemaVersion: version, publications: [record] }),
      );
      expect(open(root).publications.get(record.publication.id)).toEqual(
        record,
      );
    },
  );

  it("commits account replacement, alias and retired profile together", () => {
    const root = directory();
    const metadata = open(root);
    metadata.accounts.put(account);
    const candidate = {
      ...account,
      id: "candidate",
      profileId: "candidate-profile",
      lifecycle: "pending_identity" as const,
      externalAccountId: null,
      status: "login_required" as const,
    };
    metadata.accounts.put(candidate);
    const command = {
      candidateAccountId: candidate.id,
      survivingAccountId: account.id,
      identity: {
        platformId: account.platformId,
        identityScheme: "scheme",
        externalAccountId: account.externalAccountId,
      },
      nickname: "New",
      avatarUrl: null,
      accountInfo: [],
      replacedAt: account.createdAt,
      aliasExpiresAt: "2026-09-10T00:00:00.000Z",
      removeRetiredProfileAfter: "2026-09-10T00:00:00.000Z",
    };
    metadata.database.connection.exec(
      "CREATE TRIGGER fail_replace BEFORE INSERT ON retired_browser_profiles BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => metadata.accounts.replaceCandidateProfile(command)).toThrow();
    expect(metadata.accounts.get(candidate.id)).toEqual(candidate);
    expect(metadata.accounts.get(account.id)).toEqual(account);
    metadata.database.connection.exec("DROP TRIGGER fail_replace");
    const result = metadata.accounts.replaceCandidateProfile(command);
    metadata.database.close();
    const restarted = open(root);
    expect(
      restarted.accounts.resolve(candidate.id, new Date(account.createdAt))
        .account,
    ).toEqual(result.survivingAccount);
    expect(restarted.accounts.listRetiredProfiles()).toEqual([
      result.retiredProfile,
    ]);
  });

  it("preserves imported aliases and retired tasks", () => {
    const root = directory();
    const alias = {
      candidateAccountId: "candidate",
      survivingAccountId: account.id,
      createdAt: account.createdAt,
      expiresAt: "2026-09-10T00:00:00.000Z",
    };
    const task = {
      profileId: "old-profile",
      survivingAccountId: account.id,
      retiredAt: account.createdAt,
      removeAfter: alias.expiresAt,
      reason: "replaced_after_duplicate_login",
    };
    writeFileSync(
      join(root, `${legacySources[0]}.json`),
      JSON.stringify({
        state: {
          schemaVersion: 1,
          accounts: [account],
          replacementAliases: [alias],
          retiredProfiles: [task],
        },
      }),
    );
    const metadata = open(root);
    expect(
      metadata.accounts.resolve("candidate", new Date(account.createdAt))
        .replacementAlias,
    ).toEqual(alias);
    expect(metadata.accounts.listRetiredProfiles()).toEqual([task]);
  });

  it("does not treat damaged or nonempty unmarked databases as a fresh installation", () => {
    const root = directory();
    const file = join(root, "matrix-metadata.sqlite");
    writeFileSync(file, "not a database");
    expect(() => open(root)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("not a database");
    const unmarked = open();
    unmarked.accounts.put(account);
    unmarked.database.connection.exec("DELETE FROM legacy_imports");
    expect(() => importLegacyStores(unmarked.database, root)).toThrow(
      "Nonempty",
    );
  });

  it("backs up existing unversioned empty databases before schema creation", () => {
    const root = directory();
    const file = join(root, "matrix-metadata.sqlite");
    new DatabaseSync(file).close();
    open(root);
    const backup = readdirSync(root).find((name) =>
      name.includes("before-v1"),
    )!;
    const snapshot = new DatabaseSync(join(root, backup), { readOnly: true });
    expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    snapshot.close();
  });

  it("removes the legacy runtime binding table while upgrading schema v2", () => {
    const root = directory();
    const metadata = open(root);
    metadata.database.connection.exec(`
      CREATE TABLE runtime_account_bindings (
        platform_account_id TEXT PRIMARY KEY,
        runtime_account_id TEXT NOT NULL,
        record TEXT NOT NULL
      );
      DROP TABLE publication_attention_history;
      DROP TABLE publication_attention_resolution;
      DROP TABLE publication_query;
      DROP TABLE publication_selected_contents;
      DROP TABLE publication_deleted_requests;
      DELETE FROM legacy_imports;
      DELETE FROM schema_migrations WHERE version=5;
      DELETE FROM schema_migrations WHERE version=4;
      DELETE FROM schema_migrations WHERE version=3;
      PRAGMA user_version=2;
    `);
    metadata.database.close();

    const upgraded = open(root);
    expect(
      upgraded.database.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_account_bindings'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      upgraded.database.connection.prepare("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(5);
  });

  it("creates one database, imports three missing sources once, and persists after reopen", () => {
    const root = directory();
    const metadata = open(root);
    metadata.accounts.put(account);
    const record = publication(publishing(metadata));
    metadata.database.close();
    writeFileSync(join(root, `${legacySources[1]}.json`), "broken");
    const reopened = open(root);
    expect(reopened.publications.get(record.publication.id)).toEqual(record);
    expect(
      reopened.database.connection
        .prepare("SELECT * FROM legacy_imports")
        .all(),
    ).toHaveLength(3);
  });

  it("backs up and imports snapshots, retained flag, sequence and pending observations without changing JSON", () => {
    const source = open();
    const record = {
      ...publication(publishing(source)),
      retained: true,
      lastObservationSequence: 3,
    };
    const root = directory();
    seed(root, [record]);
    const event = { ...eventFor(record), sequence: 4 };
    writeFileSync(
      join(root, `${legacySources[2]}.json`),
      JSON.stringify({ events: [event] }),
    );
    const before = readFileSync(join(root, `${legacySources[1]}.json`));
    const imported = open(root);
    expect(imported.publications.get(record.publication.id)).toEqual(record);
    expect(imported.inbox.list()).toEqual([event]);
    expect(readFileSync(join(root, `${legacySources[1]}.json`))).toEqual(
      before,
    );
    const backup = readdirSync(join(root, "metadata-migration-backups"))[0]!;
    expect(
      readFileSync(
        join(
          root,
          "metadata-migration-backups",
          backup,
          `${legacySources[1]}.json`,
        ),
      ),
    ).toEqual(before);
  });

  it.each([
    "malformed",
    "duplicate",
    "future",
    "duplicate-json-key",
    "dangling-inbox",
  ])("rejects %s sources without partial import", (kind) => {
    const source = open();
    const record = publication(publishing(source));
    const root = directory();
    seed(root, kind === "duplicate" ? [record, record] : [record]);
    if (kind === "malformed")
      writeFileSync(
        join(root, `${legacySources[1]}.json`),
        JSON.stringify({ publications: [record, {}] }),
      );
    if (kind === "future")
      writeFileSync(
        join(root, `${legacySources[0]}.json`),
        JSON.stringify({ state: { schemaVersion: 99, accounts: [] } }),
      );
    if (kind === "duplicate-json-key")
      writeFileSync(
        join(root, `${legacySources[2]}.json`),
        '{"events":[],"events":[]}',
      );
    if (kind === "dangling-inbox")
      writeFileSync(
        join(root, `${legacySources[2]}.json`),
        JSON.stringify({
          events: [{ ...eventFor(record), publicationId: "missing" }],
        }),
      );
    expect(() => open(root)).toThrow();
    const db = new DesktopMetadataDatabase(
      join(root, "matrix-metadata.sqlite"),
    );
    databases.push(db);
    expect(
      db.connection.prepare("SELECT * FROM platform_accounts").all(),
    ).toHaveLength(0);
    expect(
      db.connection.prepare("SELECT * FROM legacy_imports").all(),
    ).toHaveLength(0);
  });

  it("defers aggregate decoding on reopen until each repository is read", () => {
    const root = directory();
    const metadata = open(root);
    metadata.accounts.put(account);
    const record = publication(publishing(metadata));
    metadata.inbox.append(eventFor(record));
    for (const table of [
      "platform_accounts",
      "publications",
      "publication_observation_inbox",
    ]) {
      metadata.database.connection.exec(`UPDATE ${table} SET record='{}'`);
    }
    metadata.database.close();

    const reopened = open(root);
    expect(() => reopened.accounts.list()).toThrow();
    expect(() => reopened.publications.get(record.publication.id)).toThrow();
    expect(() => reopened.inbox.list()).toThrow();
  });

  it("rejects invalid publication writes without replacing the stored snapshot", () => {
    const metadata = open();
    const record = publication(publishing(metadata));
    const invalid = { ...record, lastObservationSequence: -1 };

    expect(() => metadata.publications.save(invalid)).toThrow(
      "Invalid publication metadata",
    );
    expect(metadata.publications.get(record.publication.id)).toEqual(record);
  });

  it("rejects damaged publication history on read", () => {
    const metadata = open();
    const record = publication(publishing(metadata));
    const damaged = {
      ...record,
      publication: {
        ...record.publication,
        transitions: [
          {
            from: "scheduled",
            to: "preparing",
            occurredAt: record.createdAt,
          },
          ...record.publication.transitions,
        ],
      },
    };
    metadata.database.connection
      .prepare("UPDATE publications SET record=? WHERE id=?")
      .run(JSON.stringify(damaged), record.publication.id);

    expect(() => metadata.publications.get(record.publication.id)).toThrow(
      "Invalid publication metadata",
    );
  });

  it("rolls back Inbox projection when aggregate validation fails", () => {
    const metadata = open();
    const service = publishing(metadata);
    const record = publication(service);
    const event = eventFor(record);
    metadata.inbox.append(event);
    const damaged = { ...record, lastObservationSequence: -1 };
    metadata.database.connection
      .prepare("UPDATE publications SET record=? WHERE id=?")
      .run(JSON.stringify(damaged), record.publication.id);
    const queue = new PublicationObservationQueue(
      service,
      metadata.inbox,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      (operation) => metadata.database.transaction(operation),
    );

    expect(() => queue.replayPersisted()).toThrow(
      "Invalid publication metadata",
    );
    expect(metadata.inbox.list()).toEqual([event]);
    expect(
      metadata.database.connection
        .prepare("SELECT record FROM publications WHERE id=?")
        .get(record.publication.id)?.record,
    ).toBe(JSON.stringify(damaged));
  });

  it.each(["accountId", "platformId"] as const)(
    "rejects a replayed observation with mismatched %s before acknowledging it",
    (field) => {
      const root = directory();
      const metadata = open(root);
      const record = publication(publishing(metadata));
      const event = { ...eventFor(record), [field]: "wrong-identity" };
      // Even an already-applied sequence must not bypass identity validation.
      const saved = { ...record, lastObservationSequence: event.sequence };
      metadata.publications.save(saved);
      metadata.inbox.append(event);
      metadata.database.close();
      const reopened = open(root);
      const notify = vi.fn();
      const queue = new PublicationObservationQueue(
        publishing(reopened),
        reopened.inbox,
        notify,
        vi.fn(),
        vi.fn(),
        (op) => reopened.database.transaction(op),
      );

      expect(() => queue.replayPersisted()).toThrow(
        "Observation reference mismatch",
      );
      expect(reopened.inbox.list()).toEqual([event]);
      expect(reopened.publications.get(record.publication.id)).toEqual(saved);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("validates and projects a replayed observation with one publication read", () => {
    const metadata = open();
    const service = publishing(metadata);
    const record = publication(service);
    metadata.inbox.append(eventFor(record));
    const get = vi.spyOn(metadata.publications, "get");
    const queue = new PublicationObservationQueue(
      service,
      metadata.inbox,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      (op) => metadata.database.transaction(op),
    );

    queue.replayPersisted();

    expect(get).toHaveBeenCalledExactlyOnceWith(record.publication.id);
    expect(metadata.inbox.list()).toEqual([]);
    expect(
      metadata.publications.get(record.publication.id)?.publication.state,
    ).toBe("published");
  });

  it("rolls back projection when inbox acknowledgement fails, then replays exactly once", async () => {
    const root = directory();
    const metadata = open(root);
    const service = publishing(metadata);
    const record = publication(service);
    const event = eventFor(record);
    const notify = vi.fn();
    metadata.database.connection.exec(
      "CREATE TRIGGER fail_ack BEFORE DELETE ON publication_observation_inbox BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const queue = new PublicationObservationQueue(
      service,
      metadata.inbox,
      notify,
      vi.fn(),
      vi.fn(),
      (op) => metadata.database.transaction(op),
    );
    const accepted = queue.accept(event);
    expect(metadata.publications.get(record.publication.id)).toEqual(record);
    expect(metadata.inbox.list()).toEqual([event]);
    expect(notify).not.toHaveBeenCalled();
    metadata.database.connection.exec("DROP TRIGGER fail_ack");
    queue.retryPending();
    await accepted;
    expect(notify).toHaveBeenCalledOnce();
    expect(metadata.inbox.list()).toEqual([]);
    const saved = metadata.publications.get(record.publication.id)!;
    metadata.inbox.append(event);
    metadata.database.close();
    const restarted = open(root);
    new PublicationObservationQueue(
      publishing(restarted),
      restarted.inbox,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      (op) => restarted.database.transaction(op),
    ).replayPersisted();
    expect(restarted.publications.get(record.publication.id)).toEqual(saved);
  });

  it("atomically removes account and persists profile cleanup across restart", () => {
    const root = directory();
    const metadata = open(root);
    metadata.accounts.put(account);
    const record = publication(publishing(metadata));
    metadata.database.connection.exec(
      "CREATE TRIGGER fail_intent BEFORE INSERT ON retired_browser_profiles BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() =>
      metadata.accounts.removeWithProfileIntent(account.id),
    ).toThrow();
    expect(metadata.accounts.get(account.id)).toEqual(account);
    metadata.database.connection.exec("DROP TRIGGER fail_intent");
    metadata.accounts.removeWithProfileIntent(account.id);
    metadata.database.close();
    const restarted = open(root);
    expect(restarted.accounts.list()).toEqual([]);
    expect(restarted.accounts.listRetiredProfiles()[0]?.reason).toBe(
      "account_deleted",
    );
    expect(restarted.publications.get(record.publication.id)).toEqual(record);
  });

  it("enforces request uniqueness and NULL-compatible account identity", () => {
    const metadata = open();
    metadata.accounts.put(account);
    expect(() =>
      metadata.accounts.put({
        ...account,
        id: "other",
        identityScheme: "scheme",
      }),
    ).toThrow();
    const record = publication(publishing(metadata));
    expect(() =>
      metadata.publications.save({
        ...record,
        publication: { ...record.publication, id: "other" },
      }),
    ).toThrow();
  });

  it("queries and saves one publication without decoding unrelated history", () => {
    const metadata = open();
    const service = publishing(metadata);
    const first = publication(service);
    const second = publication(service, "second");
    metadata.database.connection
      .prepare("UPDATE publications SET record='{}' WHERE id=?")
      .run(second.publication.id);
    expect(metadata.publications.get(first.publication.id)).toEqual(first);
    expect(metadata.publications.findByRequestId(first.requestId)).toEqual(
      first,
    );
    expect(metadata.publications.findByRequestId("missing")).toBeUndefined();
    expect(publication(service)).toEqual(first);
    expect(publication(service, "third").requestId).toBe("third");
    expect(
      metadata.database.connection
        .prepare("SELECT count(*) AS n FROM publications")
        .get()?.n,
    ).toBe(3);
    metadata.publications.save({ ...first, retained: true });
    expect(() => metadata.publications.list()).toThrow();
  });

  it("verifies a live WAL backup and refuses future or unrecognized schemas", () => {
    const metadata = open();
    metadata.accounts.put(account);
    const backup = join(directory(), "backup.sqlite");
    metadata.database.backup(backup);
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    expect(
      snapshot.prepare("SELECT count(*) AS n FROM platform_accounts").get()?.n,
    ).toBe(1);
    snapshot.close();
    const root = directory();
    const filename = join(root, "matrix-metadata.sqlite");
    const future = new DatabaseSync(filename);
    future.exec("PRAGMA user_version=99");
    future.close();
    expect(() => open(root)).toThrow("Unsupported");
  });

  it("persists platform content snapshots and cascades them with the account", () => {
    const metadata = open();
    metadata.accounts.put(account);
    const content = {
      id: "content-local-1",
      accountId: account.id,
      platformId: account.platformId,
      externalContentId: "content-remote-1",
      contentUrl: "https://www.douyin.com/video/content-remote-1",
      contentType: "video" as const,
      title: "作品",
      description: null,
      coverUrl: null,
      publishedAt: "2026-09-08T00:00:00.000Z",
      platformStatus: "published",
      metrics: { viewCount: 12, likeCount: 2 },
      contentObservedAt: "2026-09-14T00:00:00.000Z",
      metricsObservedAt: "2026-09-14T00:00:00.000Z",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    };
    const run = {
      id: "run-1",
      accountId: account.id,
      status: "completed" as const,
      startedAt: "2026-09-14T00:00:00.000Z",
      completedAt: "2026-09-14T00:00:01.000Z",
      pagesRead: 1,
      itemsRead: 1,
      remoteTotal: 1,
      diagnostics: [],
    };

    metadata.platformContents.saveAll([content], run);
    expect(metadata.platformContents.listByAccount(account.id)).toEqual([
      content,
    ]);
    expect(
      metadata.platformContents.findMany(account.id, [
        "missing",
        content.externalContentId,
      ]),
    ).toEqual([content]);
    expect(
      metadata.platformContents.findMany("another-account", [
        content.externalContentId,
      ]),
    ).toEqual([]);
    expect(metadata.platformContents.findMany(account.id, [])).toEqual([]);
    expect(metadata.platformContents.latestRun(account.id)).toEqual(run);
    const { contentUrl: _contentUrl, ...legacyContent } = content;
    metadata.database.connection
      .prepare("UPDATE platform_contents SET record=? WHERE id=?")
      .run(JSON.stringify(legacyContent), content.id);
    expect(metadata.platformContents.listByAccount(account.id)).toEqual([
      { ...content, contentUrl: null },
    ]);
    expect(
      metadata.database.connection.prepare("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(5);

    metadata.database.connection
      .prepare("DELETE FROM platform_accounts WHERE id=?")
      .run(account.id);
    expect(metadata.platformContents.listByAccount(account.id)).toEqual([]);
    expect(metadata.platformContents.latestRun(account.id)).toBeUndefined();
  });

  it("keeps the publication query projection and attention counts in sync", () => {
    const metadata = open();
    const service = publishing(metadata);
    const record = publication(service);

    expect(
      metadata.publications.query({ view: "pending", limit: 10 }),
    ).toMatchObject({
      records: [record],
      nextCursor: null,
      counts: {
        actionRequired: 0,
        inProgress: 1,
        openAttentionRequired: 0,
        completed: 0,
      },
    });

    const uncertain = {
      ...record,
      requestId: "request-uncertain",
      publication: {
        ...record.publication,
        id: "publication-uncertain",
        state: "failed" as const,
        transitions: [
          ...record.publication.transitions,
          {
            from: record.publication.state,
            to: "failed" as const,
            occurredAt: "2026-09-09T00:00:01.000Z",
          },
        ],
      },
      contentRevision: {
        ...record.contentRevision,
        contentItemId: "publication-uncertain",
      },
      updatedAt: "2026-09-09T00:00:01.000Z",
    };
    metadata.publications.save(uncertain);
    metadata.publicationAttention.set({
      publicationId: uncertain.publication.id,
      resolution: "acknowledged_failure",
      resolvedAt: "2026-09-09T00:00:01.000Z",
    });
    expect(
      metadata.publications.query({ view: "pending", limit: 10 }),
    ).toMatchObject({
      records: [record],
      counts: { inProgress: 1, openAttentionRequired: 0 },
    });
    metadata.publicationAttention.remove(uncertain.publication.id);
    expect(
      metadata.publications.query({ view: "pending", limit: 10 }).records,
    ).toHaveLength(2);
  });

  it("counts an uncertain task with a manual work ID as completed without changing its execution", () => {
    const metadata = open();
    const base = publication(publishing(metadata));
    const uncertain = {
      ...base,
      publication: {
        ...base.publication,
        state: "uncertain" as const,
        transitions: [
          ...base.publication.transitions,
          {
            from: base.publication.state,
            to: "awaiting_confirmation" as const,
            occurredAt: "2026-09-09T00:00:00.300Z",
          },
          {
            from: "awaiting_confirmation" as const,
            to: "uncertain" as const,
            occurredAt: "2026-09-09T00:00:01.000Z",
          },
        ],
      },
      updatedAt: "2026-09-09T00:00:01.000Z",
    };
    metadata.publications.save(uncertain);
    const tasks = new PublicationService({
      publishing: metadata.publications,
      attention: metadata.publicationAttention,
      accountPublications: { isActive: () => false },
    } as never);
    expect(() =>
      tasks.resolveAttention({
        publicationId: uncertain.publication.id,
        resolution: "confirmed_published",
      }),
    ).toThrow("work ID");
    expect(
      tasks.resolveAttention({
        publicationId: uncertain.publication.id,
        resolution: "confirmed_published",
        manualPlatformContentId: "work-123",
      }).effectiveDisplayGroup,
    ).toBe("completed");
    const completed = metadata.publications.query({
      view: "all",
      group: "completed",
      limit: 10,
    });
    expect(completed.total).toBe(1);
    expect(completed.records[0]?.publication.state).toBe("uncertain");
    expect(completed.counts).toMatchObject({
      completed: 1,
      completedManual: 1,
      openAttentionRequired: 0,
      pending: 0,
    });
    expect(
      metadata.publicationAttention.history(uncertain.publication.id),
    ).toHaveLength(1);
    metadata.publicationAttention.remove(uncertain.publication.id);
    expect(
      metadata.publications.query({ view: "pending", limit: 10 }).total,
    ).toBe(1);
    expect(
      metadata.publicationAttention.history(uncertain.publication.id),
    ).toHaveLength(2);
  });

  it("upgrades schema v3 with existing publications to the task center schema", () => {
    const root = directory();
    const metadata = open(root);
    const record = publication(publishing(metadata));
    metadata.database.connection.exec(`
      DROP TABLE publication_attention_history;
      DROP TABLE publication_attention_resolution;
      DROP TABLE publication_query;
      DROP TABLE publication_selected_contents;
      DROP TABLE publication_deleted_requests;
      DELETE FROM schema_migrations WHERE version=5;
      DELETE FROM schema_migrations WHERE version=4;
      PRAGMA user_version=3;
    `);
    metadata.database.close();
    const upgraded = open(root);
    expect(
      upgraded.database.connection.prepare("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(5);
    expect(upgraded.publications.get(record.publication.id)).toEqual(record);
    expect(
      upgraded.publications.query({ view: "all", limit: 10 }).records,
    ).toEqual([record]);
    expect(
      upgraded.publicationAttention.history(record.publication.id),
    ).toEqual([]);
  });

  it("keeps a deleted request blocked while removing its selected work", () => {
    const root = directory();
    const metadata = open(root);
    const record = publication(publishing(metadata), "delete-once");
    metadata.publications.selectContent(record.publication.id, "work-123");
    expect(metadata.publications.selectedContentId(record.publication.id)).toBe(
      "work-123",
    );

    metadata.publications.remove(record.publication.id);
    expect(metadata.publications.get(record.publication.id)).toBeUndefined();
    expect(
      metadata.publications.selectedContentId(record.publication.id),
    ).toBeNull();
    expect(metadata.publications.isDeletedRequestId("delete-once")).toBe(true);
    expect(() => metadata.publications.save(record)).toThrow(
      "cannot be replayed",
    );

    metadata.database.close();
    const reopened = open(root);
    expect(reopened.publications.isDeletedRequestId("delete-once")).toBe(true);
  });

  it("upgrades a v4 publication database without changing its records", () => {
    const root = directory();
    const metadata = open(root);
    const record = publication(publishing(metadata), "v4-request");
    metadata.database.connection.exec(`
      DROP TABLE publication_selected_contents;
      DROP TABLE publication_deleted_requests;
      DELETE FROM schema_migrations WHERE version=5;
      PRAGMA user_version=4;
    `);
    metadata.database.close();

    const upgraded = open(root);
    expect(upgraded.publications.get(record.publication.id)).toEqual(record);
    expect(
      upgraded.database.connection.prepare("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(5);
    upgraded.publications.selectContent(record.publication.id, "work-1");
    expect(upgraded.publications.selectedContentId(record.publication.id)).toBe(
      "work-1",
    );
  });

  it("does not delete a publication while its observation inbox is pending", () => {
    const metadata = open();
    const record = publication(publishing(metadata), "pending-observation");
    metadata.inbox.append(eventFor(record));

    expect(() => metadata.publications.remove(record.publication.id)).toThrow(
      "pending observations",
    );
    expect(metadata.publications.get(record.publication.id)).toEqual(record);
    expect(metadata.publications.isDeletedRequestId(record.requestId)).toBe(
      false,
    );
  });

  it("rolls back all imported records when a transaction write fails", () => {
    const source = open();
    const root = directory();
    seed(root, [publication(publishing(source))]);
    const db = new DesktopMetadataDatabase(
      join(root, "matrix-metadata.sqlite"),
    );
    databases.push(db);
    db.connection.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON legacy_imports BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => importLegacyStores(db, root)).toThrow();
    expect(db.connection.prepare("SELECT * FROM publications").all()).toEqual(
      [],
    );
    expect(
      db.connection.prepare("SELECT * FROM platform_accounts").all(),
    ).toEqual([]);
  });
});
