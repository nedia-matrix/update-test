import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { OpenedBrowserContext } from "@nedia-matrix/automation-playwright";
import type { LocalVideoResource } from "@nedia-matrix/platform-sdk";

/** Browser decodes the local file and first frame; Node reads at most one 5 MiB part. */
export async function openLocalVideo(
  context: OpenedBrowserContext["context"],
  reference: string,
  signal: AbortSignal,
): Promise<LocalVideoResource> {
  signal.throwIfAborted();
  if (!isAbsolute(reference)) throw new Error("invalid_video");
  const file = await open(reference, "r");
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size <= 0 || initial.size > 2 * 1024 ** 3)
      throw new Error("video_too_large");
    const header = Buffer.alloc(12);
    if (
      (await file.read(header, 0, 12, 0)).bytesRead !== 12 ||
      header.toString("ascii", 4, 8) !== "ftyp"
    )
      throw new Error("invalid_video");
    // Use a real local document: this runtime does not complete setContent's
    // synthetic document lifecycle reliably, even for an empty file input.
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end('<!doctype html><input type="file" id="video">');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const closeServer = () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer();
      throw new Error("invalid_video");
    }
    const origin = `http://video-${randomUUID()}.localhost:${address.port}`;
    const page = await context.newPage().catch(async (error) => {
      await closeServer();
      throw error;
    });
    const abort = () => {
      void page.close().catch(() => {});
    };
    const timer = setTimeout(abort, 30000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let metadata: {
      width: number;
      height: number;
      duration: number;
      cover: string;
    };
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
      await page.goto(`${origin}/`, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      await page.locator("#video").setInputFiles(reference, { timeout: 15000 });
      metadata = await page.evaluate(async () => {
        const file = (document.querySelector("#video") as HTMLInputElement)
          .files?.[0];
        if (!file) throw new Error("missing_video");
        const url = URL.createObjectURL(file);
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        try {
          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error("video_decode_failed"));
            video.src = url;
          });
          const width = video.videoWidth,
            height = video.videoHeight,
            duration = video.duration;
          if (
            !width ||
            !height ||
            width > 8192 ||
            height > 8192 ||
            width * height > 16777216 ||
            !Number.isFinite(duration) ||
            duration <= 0
          )
            throw new Error("invalid_video_metadata");
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const painter = canvas.getContext("2d");
          if (!painter) throw new Error("video_cover_failed");
          painter.drawImage(video, 0, 0, width, height);
          const cover = canvas.toDataURL("image/jpeg", 0.9).split(",")[1]!;
          if (cover.length > 28 * 1024 * 1024)
            throw new Error("video_cover_too_large");
          return { width, height, duration, cover };
        } finally {
          video.removeAttribute("src");
          video.load();
          URL.revokeObjectURL(url);
        }
      });
    } catch {
      signal.throwIfAborted();
      throw new Error("invalid_video");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await page.close().catch(() => {});
      await closeServer();
    }
    const unchanged = async () => {
      signal.throwIfAborted();
      const current = await file.stat(),
        atPath = await stat(reference);
      if (
        current.size !== initial.size ||
        current.mtimeMs !== initial.mtimeMs ||
        atPath.ino !== initial.ino ||
        atPath.dev !== initial.dev ||
        atPath.mtimeMs !== initial.mtimeMs
      )
        throw new Error("video_changed");
    };
    await unchanged();
    return {
      size: initial.size,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
      cover: Buffer.from(metadata.cover, "base64"),
      async readPart(offset, length, cancellation) {
        cancellation.throwIfAborted();
        await unchanged();
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length <= 0 ||
          length > 5 * 1024 * 1024 ||
          offset + length > initial.size
        )
          throw new Error("invalid_video");
        const bytes = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          cancellation.throwIfAborted();
          const result = await file.read(
            bytes,
            read,
            length - read,
            offset + read,
          );
          if (!result.bytesRead) throw new Error("video_changed");
          read += result.bytesRead;
        }
        await unchanged();
        return bytes;
      },
      close: () => file.close(),
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}
