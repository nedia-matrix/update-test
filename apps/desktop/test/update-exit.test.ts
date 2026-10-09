import { describe, expect, it, vi } from "vitest";
import { completeUpdateExit } from "../src/main/bootstrap/update-exit.js";

function setup() {
  const sequence: string[] = [];
  const prepared = {
    commit: vi.fn(async () => {
      sequence.push("commit");
    }),
    cancel: vi.fn(async () => {
      sequence.push("cancel");
    }),
  };
  const dependencies = {
    cleanup: vi.fn(async () => {
      sequence.push("cleanup");
    }),
    closeDatabase: vi.fn(() => {
      sequence.push("database-close");
    }),
    exit: vi.fn(() => {
      sequence.push("exit");
    }),
  };
  return { sequence, prepared, dependencies };
}
describe("strict update exit", () => {
  it("permits replacement only after cleanup and database close", async () => {
    const { sequence, prepared, dependencies } = setup();
    await completeUpdateExit(prepared, dependencies);
    expect(sequence).toEqual(["cleanup", "database-close", "commit", "exit"]);
    expect(prepared.cancel).not.toHaveBeenCalled();
  });
  it.each(["cleanup", "database-close", "commit"])(
    "cancels without exiting when %s fails",
    async (stage) => {
      const { prepared, dependencies } = setup();
      if (stage === "cleanup")
        dependencies.cleanup.mockRejectedValue(new Error(stage));
      if (stage === "database-close")
        dependencies.closeDatabase.mockImplementation(() => {
          throw new Error(stage);
        });
      if (stage === "commit")
        prepared.commit.mockRejectedValue(new Error(stage));
      await expect(completeUpdateExit(prepared, dependencies)).rejects.toThrow(
        stage,
      );
      expect(prepared.cancel).toHaveBeenCalledOnce();
      expect(dependencies.exit).not.toHaveBeenCalled();
      if (stage !== "commit") expect(prepared.commit).not.toHaveBeenCalled();
    },
  );
  it("never converts a timeout or a late cleanup completion to an install permit", async () => {
    const { prepared, dependencies } = setup();
    let finish!: () => void;
    dependencies.cleanup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(completeUpdateExit(prepared, dependencies, 1)).rejects.toThrow(
      "超时",
    );
    finish();
    await Promise.resolve();
    expect(prepared.commit).not.toHaveBeenCalled();
    expect(dependencies.closeDatabase).not.toHaveBeenCalled();
    expect(dependencies.exit).not.toHaveBeenCalled();
  });
});
