import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { browserProfileDirectory } from "@nedia-matrix/automation-playwright";
import { publicationAssetRoles } from "@nedia-matrix/publishing";
import type { DesktopMetadataDatabase } from "./desktop-metadata-database.js";
import { array, object, observationEvent } from "./metadata-validation.js";
import {
  parseAccountState,
  parseStoredAccounts,
  type AccountStoreState,
} from "../accounts/infrastructure/account-state-codec.js";
import {
  SqliteAccountRepository,
  validateAccountState,
} from "../accounts/infrastructure/sqlite-account-repository.js";
import {
  assertSupportedPublicationStoreVersion,
  parseStoredPublications,
} from "../publishing/infrastructure/publication-state-codec.js";
import { SqlitePublicationRepository } from "../publishing/infrastructure/sqlite-publication-repository.js";
import { SqlitePublicationObservationInbox } from "../publishing/infrastructure/sqlite-publication-observation-inbox.js";

export const legacySources = [
  "matrix-platform-accounts",
  "matrix-publications",
  "matrix-publication-observation-inbox",
] as const;

function parseSource(raw: Buffer): Record<string, unknown> {
  const text = raw.toString("utf8");
  const parsed = object(JSON.parse(text));
  // JSON.parse accepts duplicate object keys; importing the last value would
  // silently discard source data. Tokenize only after syntax validation.
  const frames: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (const token of text.match(
    /"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g,
  ) ?? []) {
    const frame = frames.at(-1);
    if (token === "{" || token === "[")
      frames.push({
        object: token === "{",
        key: token === "{",
        keys: new Set(),
      });
    else if (token === "}" || token === "]") frames.pop();
    else if (token === "," && frame?.object) frame.key = true;
    else if (token.startsWith('"') && frame?.object && frame.key) {
      const key = String(JSON.parse(token));
      if (frame.keys.has(key))
        throw new Error("Duplicate JSON object key in legacy source");
      frame.keys.add(key);
      frame.key = false;
    }
  }
  return parsed;
}

function unique(values: string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate legacy metadata key");
}

function accountsFrom(source: Record<string, unknown>): AccountStoreState {
  let state: AccountStoreState;
  if (source.state !== undefined) {
    const raw = object(source.state);
    if (raw.schemaVersion !== 1)
      throw new Error("Unsupported legacy account schema");
    const parsed = parseAccountState(raw);
    if (
      !parsed ||
      parsed.accounts.length !== array(raw.accounts).length ||
      parsed.replacementAliases.length !==
        array(raw.replacementAliases ?? []).length ||
      parsed.retiredProfiles.length !== array(raw.retiredProfiles ?? []).length
    )
      throw new Error("Malformed legacy account state");
    state = parsed;
  } else {
    const raw = array(source.accounts ?? []);
    const accounts = parseStoredAccounts(raw);
    if (accounts.length !== raw.length)
      throw new Error("Malformed legacy accounts");
    state = {
      schemaVersion: 1,
      accounts,
      replacementAliases: [],
      retiredProfiles: [],
    };
  }
  const originals =
    source.state === undefined
      ? array(source.accounts ?? [])
      : array(object(source.state).accounts);
  for (const entry of originals) {
    const account = object(entry);
    if (
      account.lifecycle !== undefined &&
      !["active", "pending_identity"].includes(String(account.lifecycle))
    )
      throw new Error("Unknown account lifecycle");
  }
  validateAccountState(state);
  unique(state.replacementAliases.map((alias) => alias.candidateAccountId));
  unique(state.retiredProfiles.map((profile) => profile.profileId));
  for (const alias of state.replacementAliases) {
    if (
      !state.accounts.some(
        (account) => account.id === alias.survivingAccountId,
      ) ||
      state.accounts.some((account) => account.id === alias.candidateAccountId)
    )
      throw new Error("Invalid legacy replacement alias reference");
  }
  return state;
}

export function importLegacyStores(
  database: DesktopMetadataDatabase,
  directory: string,
): { missingAssets: number; missingActiveProfiles: number } | undefined {
  const sql = database.connection;
  const completed = sql
    .prepare("SELECT * FROM legacy_imports ORDER BY source")
    .all();
  if (completed.length) {
    if (
      completed.length !== legacySources.length ||
      completed.some(
        (row) =>
          !legacySources.includes(
            String(row.source) as (typeof legacySources)[number],
          ) ||
          ![0, 1].includes(Number(row.present)) ||
          !Number.isSafeInteger(row.count) ||
          Number(row.count) < 0 ||
          typeof row.completed_at !== "string" ||
          !Number.isFinite(Date.parse(row.completed_at)) ||
          (row.present === 0 && (row.digest !== null || row.count !== 0)) ||
          !(
            row.source === legacySources[0]
              ? ["legacy", "state:1"]
              : row.source === legacySources[1]
                ? ["legacy", "1", "2", "3", "4", "5"]
                : ["unversioned"]
          ).includes(String(row.source_version)) ||
          (row.present === 1 &&
            (typeof row.digest !== "string" ||
              !/^[a-f0-9]{64}$/.test(row.digest))),
      )
    )
      throw new Error("Invalid legacy import status");
    return;
  }
  for (const table of [
    "platform_accounts",
    "account_replacement_aliases",
    "retired_browser_profiles",
    "publications",
    "publication_observation_inbox",
  ]) {
    if (sql.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      throw new Error("Nonempty database without import status");
  }
  const sources = legacySources.map((name) => {
    let raw: Buffer | undefined;
    const filename = join(directory, `${name}.json`);
    let present = false;
    try {
      const info = lstatSync(filename);
      present = true;
      if (!info.isFile())
        throw new Error("Legacy source is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Legacy source inspection failed");
    }
    if (present) {
      try {
        raw = readFileSync(filename);
      } catch {
        throw new Error("Legacy source read failed");
      }
    }
    return {
      name,
      raw,
      digest: raw ? createHash("sha256").update(raw).digest("hex") : null,
    };
  });
  if (sources.some((source) => source.raw)) {
    const root = join(directory, "metadata-migration-backups");
    mkdirSync(root, { recursive: true });
    const backup = mkdtempSync(join(root, "legacy-"));
    for (const source of sources)
      if (source.raw) {
        const target = join(backup, `${source.name}.json`);
        writeFileSync(target, source.raw, {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
        if (
          createHash("sha256").update(readFileSync(target)).digest("hex") !==
          source.digest
        )
          throw new Error("Legacy backup verification failed");
      }
  }
  const [accountSource, publicationSource, inboxSource] = sources.map(
    (source) => (source.raw ? parseSource(source.raw) : {}),
  );
  const accounts = accountsFrom(accountSource!);
  assertSupportedPublicationStoreVersion(publicationSource!.schemaVersion);
  const rawPublications = array(publicationSource!.publications ?? []);
  const publications = parseStoredPublications(rawPublications);
  if (publications.length !== rawPublications.length)
    throw new Error("Malformed legacy publications");
  for (const entry of rawPublications) {
    const record = object(entry);
    const normalized = publications.find(
      (item) => item.publication.id === object(record.publication).id,
    )!;
    for (const field of [
      "requestId",
      "tags",
      "submissionMode",
      "submissionEvidence",
      "lastObservationSequence",
      "retained",
    ]) {
      if (
        record[field] !== undefined &&
        !isDeepStrictEqual(
          record[field],
          (normalized as unknown as Record<string, unknown>)[field],
        )
      )
        throw new Error("Unsupported legacy publication field");
    }
    for (const [index, asset] of array(record.assets).entries()) {
      const raw = object(asset);
      const canonical = normalized.assets[index] as unknown as Record<
        string,
        unknown
      >;
      for (const field of Object.keys(raw)) {
        if (!isDeepStrictEqual(raw[field], canonical[field]))
          throw new Error("Unsupported legacy asset field");
      }
      if (
        raw.role !== undefined &&
        !publicationAssetRoles.includes(raw.role as never)
      )
        throw new Error("Unknown legacy asset role");
      for (const field of [
        "mediaType",
        "hash",
        "downloadedAt",
        "sourceAssetId",
        "sourceOrigin",
        "localRelativePath",
      ]) {
        if (
          raw[field] !== undefined &&
          raw[field] !== null &&
          typeof raw[field] !== "string"
        )
          throw new Error("Invalid legacy asset field");
      }
    }
    for (const transition of array(object(record.publication).transitions)) {
      const raw = object(transition);
      if (
        Object.keys(raw).some(
          (key) => !["from", "to", "occurredAt", "reason"].includes(key),
        )
      )
        throw new Error("Unsupported legacy transition field");
    }
  }
  unique(publications.map((record) => record.publication.id));
  unique(publications.map((record) => record.requestId));
  const events = array(inboxSource!.events ?? []).map(observationEvent);
  unique(events.map((event) => event.eventId));
  for (const event of events) {
    const publication = publications.find(
      (record) => record.publication.id === event.publicationId,
    )?.publication;
    if (
      !publication ||
      publication.accountId !== event.accountId ||
      publication.platformId !== event.platformId
    )
      throw new Error("Invalid legacy observation reference");
  }
  for (const source of [accountSource!, inboxSource!]) {
    if (source.schemaVersion !== undefined)
      throw new Error("Unsupported legacy source schema");
  }
  const missing = (filename: string, kind: "file" | "directory") => {
    try {
      const info = lstatSync(filename);
      return kind === "file" ? !info.isFile() : !info.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw new Error("Legacy referenced resource inspection failed");
    }
  };
  const assetReferences = new Set(
    publications.flatMap((record) =>
      record.assets.flatMap((asset) =>
        asset.localRelativePath ? [asset.localRelativePath] : [],
      ),
    ),
  );
  for (const relative of assetReferences) {
    if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/.test(relative))
      throw new Error("Invalid legacy archived asset path");
  }
  const report = {
    missingAssets: [...assetReferences].filter((relative) =>
      missing(join(directory, "assets", relative), "file"),
    ).length,
    missingActiveProfiles: accounts.accounts.filter(
      (account) =>
        account.lifecycle === "active" &&
        missing(
          browserProfileDirectory(
            join(directory, "browser-profiles"),
            account.profileId,
          ),
          "directory",
        ),
    ).length,
  };
  database.transaction(() => {
    new SqliteAccountRepository(database).importState(accounts);
    const repository = new SqlitePublicationRepository(database);
    for (const record of publications) repository.save(record);
    const allowedFields = [
      ["state", "accounts"],
      ["schemaVersion", "publications"],
      ["events"],
    ];
    for (const [index, source] of [
      accountSource!,
      publicationSource!,
      inboxSource!,
    ].entries()) {
      if (
        Object.keys(source).some((key) => !allowedFields[index]!.includes(key))
      )
        throw new Error("Unsupported legacy source field");
    }
    const inbox = new SqlitePublicationObservationInbox(database);
    for (const event of events) inbox.append(event);
    const counts = [
      accounts.accounts.length,
      publications.length,
      events.length,
    ];
    const versions = [
      accountSource!.state ? "state:1" : "legacy",
      String(publicationSource!.schemaVersion ?? "legacy"),
      "unversioned",
    ];
    for (const [index, source] of sources.entries())
      sql
        .prepare("INSERT INTO legacy_imports VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          source.name,
          source.raw ? 1 : 0,
          source.digest,
          versions[index]!,
          counts[index]!,
          new Date().toISOString(),
        );
    const accountRepository = new SqliteAccountRepository(database);
    if (
      !isDeepStrictEqual(
        accountRepository.list().sort((a, b) => a.id.localeCompare(b.id)),
        [...accounts.accounts].sort((a, b) => a.id.localeCompare(b.id)),
      ) ||
      !isDeepStrictEqual(
        accountRepository.listRetiredProfiles(),
        accounts.retiredProfiles,
      ) ||
      sql.prepare("SELECT count(*) AS n FROM account_replacement_aliases").get()
        ?.n !== accounts.replacementAliases.length ||
      inbox.list().length !== events.length
    )
      throw new Error("Metadata import verification failed");
    if (
      !isDeepStrictEqual(
        repository
          .list()
          .sort((a, b) => a.publication.id.localeCompare(b.publication.id)),
        [...publications].sort((a, b) =>
          a.publication.id.localeCompare(b.publication.id),
        ),
      )
    )
      throw new Error("Publication import verification failed");
    database.checkIntegrity();
  });
  return report;
}
