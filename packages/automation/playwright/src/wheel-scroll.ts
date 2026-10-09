import type { Page } from "playwright";
import type { PlatformScrollResult } from "@nedia-matrix/platform-sdk";
import {
  jitterPoint,
  type HumanInteractionSession,
} from "./human-interaction.js";

export async function wheelScroll(
  page: Page,
  selector: string,
  interaction: HumanInteractionSession,
  deadline: number,
  stopped: () => boolean = () => false,
): Promise<PlatformScrollResult> {
  const target = page.locator(selector).first();
  if ((await target.count()) === 0)
    return { found: false, moved: false, atEnd: false };
  const read = () =>
    target.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
    }));
  const initial = await read();
  let current = initial;
  const result = () => ({
    found: true,
    moved: current.top > initial.top + 1,
    atEnd: current.top + current.client >= current.height - 1,
  });
  if (stopped() || initial.client <= 0) return result();
  await target.scrollIntoViewIfNeeded({
    timeout: Math.max(1, deadline - Date.now()),
  });
  const box = await target.boundingBox();
  if (!box) throw new Error("scroll_container_not_visible");
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const x = Math.max(0, box.x),
    y = Math.max(0, box.y);
  const visible = {
    x,
    y,
    width: Math.min(viewport.width, box.x + box.width) - x,
    height: Math.min(viewport.height, box.y + box.height) - y,
  };
  if (visible.width <= 0 || visible.height <= 0)
    throw new Error("scroll_container_not_visible");
  const point = jitterPoint(visible, interaction.random);
  await interaction.move(point, deadline);
  const initialEnd = Math.max(initial.top, initial.height - initial.client);
  let stalled = 0;
  // Bounded to the original extent, never chase a growing list through unconsumed pages.
  for (
    let notch = 0;
    notch < 100 && Date.now() < deadline && !stopped();
    notch++
  ) {
    interaction.check();
    if (
      current.top >= initialEnd - 1 ||
      current.top + current.client >= current.height - 1
    )
      break;
    await interaction.verifyPoint(target, point, deadline);
    if (stopped()) break;
    const before = current.top;
    await page.mouse.wheel(
      0,
      Math.min(100 + interaction.random() * 40, initialEnd - current.top),
    );
    // wheel returns before rendering; measure movement, not completion of the CDP call.
    const settleUntil = Math.min(deadline, Date.now() + 250);
    do {
      current = await read();
      if (stopped() || current.top > before + 1) break;
      if (Date.now() + 20 >= settleUntil) break;
      await interaction.wait(20, deadline);
    } while (Date.now() < settleUntil);
    if (current.top <= before + 1) stalled++;
    else stalled = 0;
    if (stalled >= 3 || stopped()) break;
    if (Date.now() + 65 >= deadline) break;
    await interaction.wait(
      20 + Math.floor(interaction.random() * 45),
      deadline,
    );
  }
  current = await read();
  return result();
}
