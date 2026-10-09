import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const state = vi.hoisted(() => ({ directory: "", exit: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => state.directory, exit: state.exit },
}));
import {
  DesktopRuntime,
  flushStartupFailureDiagnostics,
} from "../src/main/bootstrap/desktop-runtime.js";

afterEach(() => {
  if (state.directory)
    rmSync(state.directory, { recursive: true, force: true });
  state.exit.mockClear();
});

it("uses SQLite by default in normal userData and preserves legacy sources across restart", async () => {
  state.directory = mkdtempSync(join(tmpdir(), "matrix-default-storage-test-"));
  const source = join(state.directory, "matrix-publications.json");
  const original = JSON.stringify({ schemaVersion: 5, publications: [] });
  writeFileSync(source, original);
  const runtime = new DesktopRuntime();
  expect(existsSync(join(state.directory, "matrix-metadata.sqlite"))).toBe(
    true,
  );
  expect(readFileSync(source, "utf8")).toBe(original);
  runtime.requestQuit();
  await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(0));
  const db = new DatabaseSync(join(state.directory, "matrix-metadata.sqlite"), {
    readOnly: true,
  });
  expect(db.prepare("SELECT count(*) AS n FROM legacy_imports").get()?.n).toBe(
    3,
  );
  db.close();
  writeFileSync(source, "changed frozen source");
  state.exit.mockClear();
  const restarted = new DesktopRuntime();
  restarted.requestQuit();
  await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(0));
  expect(readFileSync(source, "utf8")).toBe("changed frozen source");
});

it("persists startup diagnostics when the business SQLite file is corrupt", async () => {
  state.directory = mkdtempSync(join(tmpdir(), "matrix-corrupt-storage-test-"));
  writeFileSync(
    join(state.directory, "matrix-metadata.sqlite"),
    "invalid SQLite data",
  );

  expect(() => new DesktopRuntime()).toThrow();
  await flushStartupFailureDiagnostics();
  const logDirectory = join(state.directory, "diagnostics", "logs");
  const records = readdirSync(logDirectory)
    .flatMap((name) =>
      readFileSync(join(logDirectory, name), "utf8").trim().split("\n"),
    )
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string });
  expect(records.map(({ event }) => event)).toContain(
    "persistence.sqlite.open_failed",
  );
  expect(records.map(({ event }) => event)).toContain("trace.failed");
});
