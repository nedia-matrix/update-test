import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineAutomationPage,
  defineWorkflow,
  executeWorkflow,
  type AutomationDriver,
  type AutomationTraceEvent,
} from "@nedia-matrix/automation-engine";
import { DiagnosticAttachmentStore } from "@nedia-matrix/diagnostics";
import type { PlatformBrowserPolicy } from "@nedia-matrix/platform-sdk";
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightAutomationDriver } from "../src/automation-driver.js";

describe("failure evidence", () => {
  it("writes a screenshot and metadata through the diagnostic store", async () => {
    const root = await mkdtemp(join(tmpdir(), "nedia-playwright-evidence-"));
    const traceId = "11111111-1111-4111-8111-111111111111";
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(0x49484452, 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const screenshot = vi.fn(async () => png);
    const driver = new PlaywrightAutomationDriver(
      { screenshot } as unknown as Page,
      {} as PlatformBrowserPolicy,
      join(root, "evidence", traceId),
    );

    const evidence = await driver.captureEvidence("workflow failed");
    expect(screenshot).toHaveBeenCalledWith({ fullPage: true });
    expect(evidence.relativeRef).toBe(`evidence/${traceId}/${evidence.id}.png`);
    expect(await readFile(join(root, evidence.relativeRef!))).toEqual(png);
    expect(
      JSON.parse(
        await readFile(
          join(root, "evidence", traceId, `${evidence.id}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({
      id: evidence.id,
      traceId,
      reasonCode: "workflow_failure",
    });
  });

  it.skipIf(process.env.MATRIX_BROWSER_INTEGRATION !== "1")(
    "captures a real page when a workflow target action fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nedia-real-evidence-"));
      const traceId = "11111111-1111-4111-8111-111111111111";
      const server = createServer((_request, response) =>
        response.end(
          "<!doctype html><button data-testid='submit'>Submit</button>",
        ),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test server address");
      const origin = `http://127.0.0.1:${address.port}`;
      let browser: Browser | undefined;
      try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const driver = new PlaywrightAutomationDriver(
          page,
          {
            startUrl: origin,
            allowedHostSuffixes: ["127.0.0.1"],
          } as PlatformBrowserPolicy,
          join(root, "evidence", traceId),
        );
        const failingDriver = new Proxy(driver, {
          get(target, key) {
            if (key === "click")
              return async () => {
                throw new Error("injected click failure");
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as AutomationDriver;
        const workflow = defineWorkflow({
          id: "diagnostic.failure",
          page: defineAutomationPage({
            id: "diagnostic-page",
            states: {},
            targets: {
              submit: { candidates: [{ kind: "test-id", value: "submit" }] },
            },
          }),
          startUrl: origin,
          steps: [{ kind: "click", targetId: "submit" }],
        });
        const events: AutomationTraceEvent[] = [];
        await expect(
          executeWorkflow(
            workflow,
            failingDriver,
            {},
            {
              trace: {
                executionId: "execution-1",
                report: (event) => {
                  events.push(event);
                },
              },
            },
          ),
        ).rejects.toThrow();
        const captured = events.find(
          (event) => event.type === "evidence.captured",
        );
        expect(captured?.type).toBe("evidence.captured");
        if (!captured || captured.type !== "evidence.captured") return;
        const metadata = await new DiagnosticAttachmentStore(
          join(root, "evidence"),
        ).readMetadata(traceId, captured.evidenceId);
        expect(metadata?.byteSize).toBeGreaterThan(24);
        expect(metadata?.relativeRef).toBe(captured.relativeRef);
        expect(await readFile(join(root, metadata!.relativeRef))).toHaveLength(
          metadata!.byteSize,
        );
      } finally {
        await browser?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
