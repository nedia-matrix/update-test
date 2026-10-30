import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";

export interface PinnedBrowserScriptAsset {
  readonly name: string;
  readonly sha256: string;
}
export async function openPinnedBrowserScriptHost(
  context: BrowserContext,
  options: {
    directory: string;
    assets: readonly PinnedBrowserScriptAsset[];
    functionName: string;
    requiredFunctions: readonly string[];
    writableCookie?: { name: string; argumentIndex: number };
    timeoutMs?: number;
  },
) {
  const timeout = options.timeoutMs ?? 10_000;
  // Load and verify every asset before executing any of them. Options are composition-root configuration, never task inputs.
  const scripts = await Promise.all(
    options.assets.map(async (asset) => {
      if (
        !/^[a-zA-Z0-9_.-]+\.js$/.test(asset.name) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256)
      )
        throw new Error("Pinned browser asset configuration invalid");
      const data = await readFile(join(options.directory, asset.name));
      if (
        data.byteLength > 2_000_000 ||
        createHash("sha256").update(data).digest("hex") !== asset.sha256
      )
        throw new Error("Pinned browser asset digest mismatch");
      return data.toString("utf8");
    }),
  );
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end("<!doctype html><title>Signing helper</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Signing helper address unavailable");
  const hostname = `sign-${randomUUID()}.localhost`;
  const origin = `http://${hostname}:${address.port}`;
  const page = await context.newPage().catch(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    throw new Error("Signing helper page unavailable");
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  let tail = Promise.resolve();
  async function close() {
    closed = true;
    return (closing ??= (async () => {
      try {
        if (!page.isClosed()) {
          const cdp = await context.newCDPSession(page);
          try {
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                cdp.send("Storage.clearDataForOrigin", {
                  origin,
                  storageTypes: "all",
                }),
                new Promise<void>((resolve) => {
                  cleanupTimer = setTimeout(resolve, 1000);
                }),
              ]);
            } finally {
              clearTimeout(cleanupTimer);
            }
          } finally {
            await cdp.detach().catch(() => {});
          }
        }
      } catch {
        /* The closed renderer must not prevent cleanup. */
      } finally {
        await page.close().catch(() => {});
        await context.clearCookies({ domain: hostname }).catch(() => {});
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    })());
  }
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            closed = true;
            void page.close().catch(() => {});
            reject(new Error("Signing helper timeout"));
          }, timeout);
        }),
      ]);
    } catch {
      closed = true;
      void page.close().catch(() => {});
      throw new Error("Signing helper failed");
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await page.route("**/*", (route) =>
      route.request().url() === `${origin}/` &&
      route.request().isNavigationRequest() &&
      route.request().method() === "GET" &&
      route.request().frame() === page.mainFrame()
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    await page.routeWebSocket("**/*", (socket) => socket.close());
    await bounded(async () => {
      await page.goto(origin, { timeout, waitUntil: "domcontentloaded" });
      for (const content of scripts) await page.addScriptTag({ content });
      const ready = await page.evaluate(
        (names) =>
          names.every(
            (name) => typeof Reflect.get(window, name) === "function",
          ),
        options.requiredFunctions,
      );
      if (!ready) throw new Error("Signing functions missing");
    });
    return {
      invoke(args: readonly unknown[]): Promise<unknown> {
        const next = tail.then(() => {
          if (closed) throw new Error("Signing helper closed");
          return bounded(() =>
            page.evaluate(
              ({ name, args, writableCookie }) => {
                const fn: unknown = Reflect.get(window, name);
                if (typeof fn !== "function")
                  throw new Error("Signing function missing");
                const value: unknown = fn(...args);
                if (
                  writableCookie &&
                  !document.cookie
                    .split("; ")
                    .includes(
                      `${writableCookie.name}=${String(args[writableCookie.argumentIndex])}`,
                    )
                )
                  throw new Error("Signing helper Cookie is not writable");
                return value;
              },
              {
                name: options.functionName,
                args: [...args],
                writableCookie: options.writableCookie,
              },
            ),
          );
        });
        tail = next.then(
          () => {},
          () => {},
        );
        return next;
      },
      close,
    };
  } catch {
    await close();
    throw new Error("Signing helper initialization failed");
  }
}
