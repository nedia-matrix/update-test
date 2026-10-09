import type { ElementHandle, Locator, Page } from "playwright";

type ClickTarget = Locator | ElementHandle;
export interface Point {
  x: number;
  y: number;
}
export interface Box extends Point {
  width: number;
  height: number;
}
type TimingAction =
  "pointer" | "hold" | "key" | "navigate" | "scroll" | "submit";
const timing: Record<TimingAction, readonly [number, number, number, number]> =
  {
    pointer: [-1.2, 0.35, 200, 1200],
    hold: [-2.47, 0.33, 45, 250],
    key: [-2.12, 0.5, 30, 400],
    navigate: [0.41, 0.45, 600, 3000],
    scroll: [-0.22, 0.4, 250, 2000],
    submit: [0, 0.4, 400, 4000],
  };

export function sampleTiming(
  action: TimingAction,
  random = Math.random,
): number {
  const [mu, sigma, min, max] = timing[action];
  const z =
    Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random()))) *
    Math.cos(2 * Math.PI * random());
  return Math.round(
    Math.min(max, Math.max(min, Math.exp(mu + sigma * z) * 1000)),
  );
}

export function curvePoints(
  start: Point,
  end: Point,
  random = Math.random,
): Point[] {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 6) return [end];
  const count = Math.min(40, Math.max(10, Math.round(distance / 10)));
  const offset = distance * (0.05 + random() * 0.1) * (random() < 0.5 ? -1 : 1);
  const c1 = {
    x: start.x + dx / 3 - (dy / distance) * offset,
    y: start.y + dy / 3 + (dx / distance) * offset,
  };
  const c2 = {
    x: start.x + (dx * 2) / 3 - ((dy / distance) * offset) / 2,
    y: start.y + (dy * 2) / 3 + ((dx / distance) * offset) / 2,
  };
  return Array.from({ length: count }, (_, i) => {
    const progress = (i + 1) / count;
    const t =
      progress < 0.5 ? 2 * progress ** 2 : 1 - (-2 * progress + 2) ** 2 / 2;
    const u = 1 - t;
    return {
      x:
        u ** 3 * start.x +
        3 * u ** 2 * t * c1.x +
        3 * u * t ** 2 * c2.x +
        t ** 3 * end.x,
      y:
        u ** 3 * start.y +
        3 * u ** 2 * t * c1.y +
        3 * u * t ** 2 * c2.y +
        t ** 3 * end.y,
    };
  });
}

export function jitterPoint(box: Box, random = Math.random): Point {
  return {
    x:
      box.x +
      box.width / 2 +
      (random() * 2 - 1) * Math.min(box.width * 0.15, 8),
    y:
      box.y +
      box.height / 2 +
      (random() * 2 - 1) * Math.min(box.height * 0.15, 8),
  };
}

export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Serializes automatic input devices belonging to the same browser context. */
export class InteractionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
const accountQueues = new WeakMap<object, InteractionQueue>();
export function accountInteractionQueue(context: object): InteractionQueue {
  let queue = accountQueues.get(context);
  if (!queue) {
    queue = new InteractionQueue();
    accountQueues.set(context, queue);
  }
  return queue;
}

export interface HumanInteractionOptions {
  random?: () => number;
  queue?: InteractionQueue;
}

/** A page owns one session; revocation interrupts waits and every input loop. */
export class HumanInteractionSession {
  private readonly controller = new AbortController();
  private position: Point = { x: 0, y: 0 };
  readonly random: () => number;
  readonly queue: InteractionQueue;
  constructor(
    readonly page: Page,
    options: HumanInteractionOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.queue = options.queue ?? new InteractionQueue();
  }
  get signal() {
    return this.controller.signal;
  }
  stop() {
    this.controller.abort(new Error("页面控制权已移交或自动操作已取消"));
  }
  check(deadline = Infinity) {
    this.signal.throwIfAborted();
    if (this.page.isClosed()) throw new Error("页面已关闭");
    if (Date.now() >= deadline) throw new Error("interaction_timeout");
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      this.check();
      return operation();
    });
  }
  async wait(ms: number, deadline = Infinity) {
    this.check(deadline);
    await abortableWait(
      Math.min(ms, Math.max(0, deadline - Date.now())),
      this.signal,
    );
    this.check(deadline);
  }
  pause(action: TimingAction, deadline = Infinity) {
    return this.wait(sampleTiming(action, this.random), deadline);
  }
  async move(point: Point, deadline: number) {
    this.check(deadline);
    const viewport = await this.page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= viewport.width ||
      point.y >= viewport.height
    )
      throw new Error("click_point_outside_viewport");
    for (const step of curvePoints(this.position, point, this.random)) {
      this.check(deadline);
      await this.page.mouse.move(
        Math.min(viewport.width - 1, Math.max(0, step.x)),
        Math.min(viewport.height - 1, Math.max(0, step.y)),
      );
      await this.wait(5 + Math.floor(this.random() * 5), deadline);
    }
    this.position = point;
  }
  async click(
    target: ClickTarget,
    ratio?: Point,
    deadline = Date.now() + 30_000,
  ) {
    this.check(deadline);
    // A trial click itself moves the native pointer. Keep readiness checks free of
    // mouse movement, then let the final Locator click perform actionability checks.
    await target.scrollIntoViewIfNeeded({
      timeout: Math.max(1, deadline - Date.now()),
      signal: this.signal,
    });
    while (!(await target.isEnabled())) await this.wait(50, deadline);
    const box = await target.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0)
      throw new Error("target_has_no_clickable_box");
    const viewport = await this.page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const visible = {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(viewport.width, box.x + box.width) - Math.max(0, box.x),
      height:
        Math.min(viewport.height, box.y + box.height) - Math.max(0, box.y),
    };
    if (visible.width <= 0 || visible.height <= 0)
      throw new Error("target_has_no_visible_box");
    // Ratio clicks carry business meaning; jitter requires a separately known safe region.
    const point = ratio
      ? { x: box.x + box.width * ratio.x, y: box.y + box.height * ratio.y }
      : jitterPoint(visible, this.random);
    await this.move(point, deadline);
    await this.pause("pointer", deadline);
    const [fresh, border] = await Promise.all([
      target.boundingBox(),
      (target as Locator).evaluate((element) => {
        const style =
          element.ownerDocument.defaultView!.getComputedStyle(element);
        return {
          x: parseFloat(style.borderLeftWidth) || 0,
          y: parseFloat(style.borderTopWidth) || 0,
        };
      }),
    ]);
    if (!fresh) throw new Error("target_has_no_clickable_box");
    await this.verifyPoint(target, point, deadline);
    this.check(deadline);
    // Playwright offsets positions from the padding box, while boundingBox
    // includes the border. Keep the native click at the verified viewport point.
    await target.click({
      position: {
        x: point.x - fresh.x - border.x,
        y: point.y - fresh.y - border.y,
      },
      delay: sampleTiming("hold", this.random),
      timeout: Math.max(1, deadline - Date.now()),
      signal: this.signal,
    });
    this.position = point;
  }
  async verifyPoint(target: ClickTarget, point: Point, deadline: number) {
    this.check(deadline);
    const valid = await (target as Locator).evaluate((element, p) => {
      const rect = element.getBoundingClientRect();
      // Verify every shadow boundary, including nested open/closed roots.
      for (let candidate: Element | null = element; candidate;) {
        const root = candidate.getRootNode() as Document | ShadowRoot;
        const hit = root.elementFromPoint(p.x, p.y);
        if (!hit || !(candidate === hit || candidate.contains(hit)))
          return false;
        candidate = (root as ShadowRoot).host ?? null;
      }
      let opacity = 1;
      for (
        let current: Element | null = element;
        current;
        current =
          current.parentElement ??
          (current.getRootNode() as ShadowRoot).host ??
          null
      ) {
        const style = getComputedStyle(current);
        if (style.visibility !== "visible" || style.display === "none")
          return false;
        opacity *= Number(style.opacity);
      }
      return (
        opacity >= 0.1 &&
        p.x >= rect.left &&
        p.x <= rect.right &&
        p.y >= rect.top &&
        p.y <= rect.bottom
      );
    }, point);
    if (!valid || !(await target.isEnabled()))
      throw new Error("click_target_moved_or_obscured");
    this.check(deadline);
  }
  async type(target: Locator, value: string, explicitDelay?: number) {
    const segments = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      (part) => part.segment,
    );
    const intervals = segments.map(
      () => explicitDelay ?? sampleTiming("key", this.random),
    );
    if (intervals.some((ms) => !Number.isFinite(ms) || ms < 0))
      throw new TypeError("Invalid typing delay");
    const deadline =
      Date.now() +
      30_000 +
      intervals.reduce((sum, ms) => sum + ms, 0) +
      segments.length * 250;
    for (const [i, text] of segments.entries()) {
      this.check(deadline);
      // A body space is literal text; topic Space/Enter commands remain pressKey actions.
      if (text === " ") await this.page.keyboard.insertText(text);
      else
        await target.pressSequentially(text, {
          delay: 0,
          timeout: Math.max(1, deadline - Date.now()),
          signal: this.signal,
        });
      await this.wait(intervals[i]!, deadline);
    }
  }
}

const pageSessions = new WeakMap<Page, HumanInteractionSession>();
export function pageInteractionSession(page: Page): HumanInteractionSession {
  let session = pageSessions.get(page);
  if (!session) {
    session = new HumanInteractionSession(page, {
      queue: accountInteractionQueue(page.context()),
    });
    pageSessions.set(page, session);
    page.once("close", () => session!.stop());
  }
  return session;
}
