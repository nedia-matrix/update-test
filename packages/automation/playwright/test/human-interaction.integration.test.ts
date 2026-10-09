import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  PlaywrightAutomationDriver,
  createManagedBrowserPage,
  createPlaywrightPlatformDataClient,
  openPersistentBrowserContext,
} from "../src/index.js";
import { verifyFingerprintBrowser } from "../src/browser-runtime.js";
import { HumanInteractionSession } from "../src/human-interaction.js";

// All pages and HTTP responses are synthetic; no external account is touched.
describe.skipIf(process.env.MATRIX_BROWSER_INTEGRATION !== "1")(
  "native human interactions",
  () => {
    let browser: Browser;
    let origin: string;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/items")) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ items: [{ id: 1 }] }));
      } else if (request.url === "/limited") {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "30",
        });
        response.end('{"error":"limited"}');
      } else response.end("<!doctype html><body>Synthetic</body>");
    });
    beforeAll(async () => {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No local address");
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const policy = () => ({
      startUrl: origin,
      allowedHostSuffixes: ["127.0.0.1"],
    });

    it("refuses a target that moves during the curve and preserves ratio click meaning", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.setContent(
          '<button data-testid="moving" style="position:absolute;left:120px;top:100px;width:100px;height:60px">Move</button>',
        );
        await page.evaluate(() => {
          const button = document.querySelector("button")!;
          Reflect.set(window, "clicked", 0);
          button.addEventListener("click", () =>
            Reflect.set(window, "clicked", 1),
          );
          document.addEventListener(
            "mousemove",
            () => (button.style.left = "700px"),
            { once: true },
          );
        });
        const driver = new PlaywrightAutomationDriver(
          page,
          policy(),
          "/tmp/evidence",
        );
        const moving = (
          await driver.query({ kind: "test-id", value: "moving" })
        )[0]!;
        await expect(driver.click(moving)).rejects.toThrow("moved_or_obscured");
        expect(await page.evaluate(() => Reflect.get(window, "clicked"))).toBe(
          0,
        );
        await page.setContent(
          '<div data-testid="host" style="margin:40px;width:300px;display:flex"><button style="width:150px;height:80px">Left</button><button style="width:150px;height:80px">Right</button></div>',
        );
        await page.evaluate(() => {
          document
            .querySelectorAll("button")
            .forEach((button) =>
              button.addEventListener("click", () =>
                Reflect.set(window, "clicked", button.textContent),
              ),
            );
        });
        const host = (
          await driver.query({ kind: "test-id", value: "host" })
        )[0]!;
        await driver.clickAtPosition(host, 0.75, 0.5);
        expect(await page.evaluate(() => Reflect.get(window, "clicked"))).toBe(
          "Right",
        );
      } finally {
        await context.close();
      }
    });

    it.each([1, 1.5])(
      "preserves bordered ratio and ordinary click points at scale %s",
      async (scale) => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.setContent(
            `<div data-testid="host" style="position:absolute;left:100px;top:100px;border:20px solid black;width:300px;height:80px;display:flex;transform:scale(${scale});transform-origin:top left"><button data-testid="left" style="padding:0;border:4px solid black;width:150px">Left</button><button style="padding:0;border:0;width:150px">Right</button></div>`,
          );
          await page.evaluate(() => {
            const events: { x: number; y: number; target: string | null }[] =
              [];
            Reflect.set(window, "clicks", events);
            document.addEventListener("click", (event) =>
              events.push({
                x: event.clientX,
                y: event.clientY,
                target: (event.target as HTMLElement).textContent,
              }),
            );
          });
          const driver = new PlaywrightAutomationDriver(
            page,
            policy(),
            "/tmp/evidence",
            new HumanInteractionSession(page, { random: () => 0.5 }),
          );
          const [host] = await driver.query({ kind: "test-id", value: "host" });
          const box = (await page.getByTestId("host").boundingBox())!;
          await driver.clickAtPosition(host!, 0.49, 0.5);
          const [left] = await driver.query({ kind: "test-id", value: "left" });
          const button = (await page.getByTestId("left").boundingBox())!;
          await driver.click(left!);
          const clicks = await page.evaluate(() =>
            Reflect.get(window, "clicks"),
          );
          expect(clicks).toHaveLength(2);
          for (const [index, point] of [
            { x: box.x + box.width * 0.49, y: box.y + box.height * 0.5 },
            {
              x: button.x + button.width * 0.5,
              y: button.y + button.height * 0.5,
            },
          ].entries()) {
            expect(clicks[index].target).toBe("Left");
            expect(Math.abs(clicks[index].x - point.x)).toBeLessThan(1);
            expect(Math.abs(clicks[index].y - point.y)).toBeLessThan(1);
          }
        } finally {
          await context.close();
        }
      },
      10_000,
    );

    it("preserves rich Unicode text and emits a curved pointer with a held single click", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.setContent(
          '<textarea data-testid="body" style="margin:80px;width:500px;height:160px"></textarea>',
        );
        await page.evaluate(() => {
          const state = {
            moves: [] as number[][],
            clicks: 0,
            down: 0,
            hold: 0,
            trusted: true,
          };
          Reflect.set(window, "events", state);
          document.addEventListener("mousemove", (e) =>
            state.moves.push([e.clientX, e.clientY]),
          );
          document.addEventListener("mousedown", (e) => {
            state.down = performance.now();
            state.trusted &&= e.isTrusted;
          });
          document.addEventListener("mouseup", (e) => {
            state.hold = performance.now() - state.down;
            state.trusted &&= e.isTrusted;
          });
          document.addEventListener("click", () => state.clicks++);
        });
        const driver = new PlaywrightAutomationDriver(
          page,
          policy(),
          "/tmp/evidence",
        );
        const target = (
          await driver.query({ kind: "test-id", value: "body" })
        )[0]!;
        const text = "中文 👩‍💻 e\u0301\n正文 #话题  分隔";
        await driver.fill(target, text);
        expect(await page.locator("textarea").inputValue()).toBe(text);
        const events = await page.evaluate(() => Reflect.get(window, "events"));
        expect(events.clicks).toBe(1);
        expect(events.hold).toBeGreaterThanOrEqual(40);
        expect(events.trusted).toBe(true);
        expect(events.moves.length).toBeGreaterThanOrEqual(10);
        const end = events.moves.at(-1);
        expect(
          events.moves
            .slice(1, -1)
            .some(
              (p: number[]) => Math.abs(p[0]! * end[1] - p[1]! * end[0]) > 1,
            ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    }, 20_000);

    it("cancels long typing at handoff and issues no subsequent input", async () => {
      const context = await browser.newContext();
      try {
        const managed = await createManagedBrowserPage(
          {
            context,
            headless: true,
            channel: "test",
            close: () => context.close(),
          },
          {
            browser: policy(),
            profileDirectory: "/tmp/synthetic",
            profileId: "test",
            evidenceDirectory: "/tmp/evidence",
            sessionDetection: { probes: [] },
          },
          "sync",
        );
        await managed.page.setContent(
          '<textarea data-testid="body"></textarea>',
        );
        const target = (
          await managed.driver.query({ kind: "test-id", value: "body" })
        )[0]!;
        const typing = expect(
          managed.driver.typeText(target, "长".repeat(2000)),
        ).rejects.toThrow("控制权");
        await managed.page.waitForFunction(
          () =>
            (document.querySelector("textarea") as HTMLTextAreaElement).value
              .length > 0,
        );
        const started = Date.now();
        await managed.handoff();
        await typing;
        expect(Date.now() - started).toBeLessThan(1000);
        const value = await managed.page.locator("textarea").inputValue();
        await managed.page.waitForTimeout(500);
        expect(await managed.page.locator("textarea").inputValue()).toBe(value);
        expect(value.length).toBeLessThan(2000);
      } finally {
        await context.close();
      }
    });

    it("clicks the actual closed shadow button once", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.setContent(
          '<div data-testid="host" style="margin:80px;width:200px;height:80px"></div>',
        );
        await page.evaluate(() => {
          const host = document.querySelector("div")!;
          const root = host.attachShadow({ mode: "closed" });
          root.innerHTML =
            '<button class="publish" style="width:180px;height:60px">Publish</button>';
          Reflect.set(window, "count", 0);
          root
            .querySelector("button")!
            .addEventListener("click", () =>
              Reflect.set(window, "count", Reflect.get(window, "count") + 1),
            );
        });
        const driver = new PlaywrightAutomationDriver(
          page,
          policy(),
          "/tmp/evidence",
        );
        const target = (
          await driver.query({ kind: "test-id", value: "host" })
        )[0]!;
        await driver.clickClosedShadowDescendant(target, "button", "publish");
        expect(await page.evaluate(() => Reflect.get(window, "count"))).toBe(1);
        expect(
          await page.locator("div").getAttribute("data-nedia-shadow-click"),
        ).toBeNull();
      } finally {
        await context.close();
      }
    });

    it("uploads through visible input and label once, and falls back before clicking a covered or hidden input", async () => {
      const context = await browser.newContext();
      const directory = await mkdtemp(join(tmpdir(), "nedia-native-upload-"));
      const file = join(directory, "synthetic.png");
      await writeFile(file, Buffer.from([1, 2, 3]));
      try {
        const page = await context.newPage();
        let chooserCount = 0;
        page.on("filechooser", () => chooserCount++);
        for (const [html, expectedChoosers] of [
          ['<input data-testid="file" type="file">', 1],
          [
            '<label for="file" style="display:inline-block;width:200px;height:60px">Upload</label><input id="file" data-testid="file" type="file" hidden>',
            1,
          ],
          ['<input data-testid="file" type="file" hidden>', 0],
          [
            '<input data-testid="file" type="file" style="position:absolute;left:0;top:0;width:200px;height:60px"><div style="position:absolute;left:0;top:0;width:200px;height:60px;background:white">Covered</div>',
            0,
          ],
        ] as const) {
          chooserCount = 0;
          await page.setContent(html);
          const driver = new PlaywrightAutomationDriver(
            page,
            policy(),
            "/tmp/evidence",
          );
          const target = (
            await driver.query({ kind: "test-id", value: "file" })
          )[0]!;
          await driver.uploadFiles(target, [file]);
          expect(chooserCount).toBe(expectedChoosers);
          expect(
            await page
              .locator("input")
              .evaluate(async (el) =>
                Array.from(
                  (el as HTMLInputElement).files ?? [],
                  (file) => file.name,
                ),
              ),
          ).toEqual(["synthetic.png"]);
        }
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 15_000);

    it("stops a growing nested list at the first matching response", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(origin);
        await page.setContent(
          '<div id="list" style="height:200px;width:400px;overflow:auto"><div style="height:1600px"></div></div>',
        );
        const client = createPlaywrightPlatformDataClient(
          context,
          page,
          policy(),
        );
        await page.evaluate(() => {
          const list = document.getElementById("list")!;
          let requested = false;
          list.addEventListener("scroll", () => {
            if (list.scrollTop < 100 || requested) return;
            requested = true;
            void fetch("/items?page=1").then(() => {
              list.firstElementChild!.setAttribute("style", "height:5000px");
            });
          });
        });
        const result = await client.scrollForJsonResponse!({
          selector: "#list",
          response: { method: "GET", url: `${origin}/items`, timeoutMs: 5000 },
        });
        expect(result.response?.body).toEqual({ items: [{ id: 1 }] });
        expect(result.scroll.moved).toBe(true);
        expect(
          await page.locator("#list").evaluate((el) => el.scrollTop),
        ).toBeLessThan(500);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        client.dispose();
        await expect(
          client.waitForJsonResponse({
            method: "GET",
            url: `${origin}/items`,
            timeoutMs: 100,
          }),
        ).resolves.toBeNull();
      } finally {
        await context.close();
      }
    }, 10_000);

    it("does not replay rate-limited requests through page fetch or another page", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(origin);
        const client = createPlaywrightPlatformDataClient(
          context,
          page,
          policy(),
        );
        const response = await client.requestJson({
          method: "GET",
          url: `${origin}/limited`,
        });
        expect(response.status).toBe(429);
        expect(response.retryAfterMs).toBe(30_000);
        const secondPage = await context.newPage();
        const second = createPlaywrightPlatformDataClient(
          context,
          secondPage,
          policy(),
        );
        await expect(
          second.requestJson({ method: "GET", url: `${origin}/items` }),
        ).rejects.toThrow("rate_limited");
        client.dispose();
        second.dispose();
      } finally {
        await context.close();
      }
    });

    it("retains an account environment across persistent context reopen", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "nedia-persistent-environment-"),
      );
      const options = {
        browser: policy(),
        sessionDetection: { probes: [] },
        profileDirectory: directory,
        profileId: "test",
        evidenceDirectory: "/tmp/evidence",
        headless: true,
        preferredChannel: "Playwright Chromium",
        runtime: { provider: "system" as const },
      };
      try {
        const first = await openPersistentBrowserContext(options);
        const a = JSON.parse(
          await readFile(join(directory, "nedia-browser-runtime.json"), "utf8"),
        );
        await first.close();
        const second = await openPersistentBrowserContext(options);
        try {
          const b = JSON.parse(
            await readFile(
              join(directory, "nedia-browser-runtime.json"),
              "utf8",
            ),
          );
          expect(b).toEqual(a);
          const page = await second.context.newPage();
          expect(await page.evaluate(() => navigator.language)).toBe(a.locale);
          expect(
            await page.evaluate(
              () => Intl.DateTimeFormat().resolvedOptions().timeZone,
            ),
          ).toBe(a.timezoneId);
        } finally {
          await second.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects a stock browser as a native fingerprint provider", async () => {
      await expect(
        verifyFingerprintBrowser(chromium.executablePath()),
      ).rejects.toThrow("native fingerprint flags");
    }, 30_000);
    it.skipIf(!process.env.NEDIA_FINGERPRINT_BROWSER_PATH)(
      "backs up a system profile and keeps native fingerprint values and cookies across reopen",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "nedia-native-profile-"));
        const directory = join(root, "profile");
        const options = {
          browser: policy(),
          sessionDetection: { probes: [] },
          profileDirectory: directory,
          profileId: "native",
          evidenceDirectory: join(root, "evidence"),
          headless: true,
        };
        const executablePath = process.env.NEDIA_FINGERPRINT_BROWSER_PATH!;
        try {
          const original = await openPersistentBrowserContext({
            ...options,
            preferredChannel: "Playwright Chromium",
            runtime: { provider: "system" },
          });
          await original.context.addCookies([
            {
              name: "synthetic",
              value: "preserved",
              url: origin,
              expires: Math.floor(Date.now() / 1000) + 3600,
            },
          ]);
          await original.close();
          await writeFile(join(directory, "backup-marker"), "Synthetic backup");
          const configuration = {
            provider: "fingerprint" as const,
            executablePath,
          };
          const snapshot = async (
            context: Awaited<
              ReturnType<typeof openPersistentBrowserContext>
            >["context"],
          ) => {
            const page = await context.newPage();
            return page.evaluate(() => {
              const canvas = document.createElement("canvas");
              canvas.width = 160;
              canvas.height = 80;
              const drawing = canvas.getContext("2d")!;
              drawing.fillText("Synthetic identity", 5, 20);
              return {
                canvas: canvas.toDataURL(),
                hardwareConcurrency: navigator.hardwareConcurrency,
                language: navigator.language,
                userAgent: navigator.userAgent,
                platform: navigator.platform,
              };
            });
          };
          const first = await openPersistentBrowserContext({
            ...options,
            runtime: configuration,
          });
          let a;
          let metadata;
          try {
            a = await snapshot(first.context);
            metadata = JSON.parse(
              await readFile(
                join(directory, "nedia-browser-runtime.json"),
                "utf8",
              ),
            );
            expect(
              (await first.context.cookies(origin)).some(
                (cookie) =>
                  cookie.name === "synthetic" && cookie.value === "preserved",
              ),
            ).toBe(true);
          } finally {
            await first.close();
          }
          const backup = (await readdir(root)).find((name) =>
            name.startsWith("profile.before-fingerprint-"),
          );
          expect(backup).toBeDefined();
          expect(
            await readFile(join(root, backup!, "backup-marker"), "utf8"),
          ).toBe("Synthetic backup");
          const second = await openPersistentBrowserContext({
            ...options,
            runtime: configuration,
          });
          try {
            expect(await snapshot(second.context)).toEqual(a);
            expect(
              JSON.parse(
                await readFile(
                  join(directory, "nedia-browser-runtime.json"),
                  "utf8",
                ),
              ),
            ).toEqual(metadata);
          } finally {
            await second.close();
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      45_000,
    );
  },
);
