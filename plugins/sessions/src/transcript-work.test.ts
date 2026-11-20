import { expect, it } from "vitest";
import { TranscriptWork } from "./transcript-work.js";

it("bounds parser concurrency, prioritizes foreground and guarantees backfill progress", async () => {
  const queue = new TranscriptWork();
  let active = 0, peak = 0;
  const order: string[] = [];
  const add = (label: string, foreground: boolean) => queue.run(foreground, async () => {
    peak = Math.max(peak, ++active);
    order.push(label);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--; return label;
  });
  const tasks = [add("initial", false), add("backfill", false), ...Array.from({ length: 8 }, (_, i) => add(`live-${i}`, true))];
  await Promise.all(tasks);
  expect(peak).toBe(1);
  expect(order.slice(0, 5)).toEqual(["initial", "live-0", "live-1", "live-2", "backfill"]);
});
