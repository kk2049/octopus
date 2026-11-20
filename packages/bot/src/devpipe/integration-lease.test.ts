import { afterEach, expect, it, vi } from "vitest";
import { IntegrationLeaseKeeper } from "./integration-lease.js";
import { GitLabMainline, MainlineError, type IntegrationLease } from "./gitlab-mainline.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const lease = { id: "cli", epoch: "original", base: "a".repeat(40) } as IntegrationLease;
  const renew = vi.fn(async () => lease), publish = vi.fn(async () => "new"), release = vi.fn(async () => {});
  const client = { leaseMs: 3000, renew, publish, release } as unknown as GitLabMainline;
  return { lease, renew, publish, release, keeper: new IntegrationLeaseKeeper(client, lease, Date.now() + 4000) };
}
it("fences publication after ambiguous renewal without retrying that mutation", async () => {
  const f = fixture(); f.renew.mockRejectedValue(new MainlineError("unknown", "lost acknowledgement"));
  await vi.advanceTimersByTimeAsync(1000);
  await expect(f.keeper.publish("candidate")).rejects.toThrow(/acknowledgement/);
  expect(f.renew).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled();
  await f.keeper.close();
});
it("retries only a definite CAS contention and releases the exact epoch", async () => {
  const f = fixture(); f.renew.mockRejectedValueOnce(new MainlineError("busy", "CAS refused"));
  await f.keeper.renew(); expect(f.renew).toHaveBeenCalledTimes(2);
  await f.keeper.close(); expect(f.release).toHaveBeenCalledWith(f.lease);
  await vi.advanceTimersByTimeAsync(4000); expect(f.renew).toHaveBeenCalledTimes(2);
});
it("bounds renewal by an absolute deadline and leaves no timer after publication", async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(4000);
  await expect(f.keeper.publish("candidate")).rejects.toThrow(/deadline/); expect(f.publish).not.toHaveBeenCalled();
  await f.keeper.close(); expect(vi.getTimerCount()).toBe(0);
  const g = fixture(); expect(await g.keeper.publish("candidate")).toBe("new");
  await g.keeper.close(); expect(g.release).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
