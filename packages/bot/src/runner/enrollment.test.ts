import { describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { issueRunnerEnrollment, redeemRunnerEnrollment, RUNNER_ENROLLMENT_TTL_MS } from "./enrollment.js";

const NOW = new Date("2026-08-28T00:00:00.000Z");

function fixture() {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW.toISOString() });
  const mintDeviceToken = vi.fn((_username: string, _device: string) => `rt_${"b".repeat(32)}`);
  return { store, caps: { mintDeviceToken }, mintDeviceToken };
}

describe("Runner installation enrollment", () => {
  it("stores only a hash and mints the durable credential exactly once on redemption", () => {
    const f = fixture();
    const issued = issueRunnerEnrollment(f.store, "alice", "mac", NOW);
    expect(issued.code).toMatch(/^re_[0-9a-f]{48}$/);
    expect(issued.expires_at).toBe(new Date(NOW.getTime() + RUNNER_ENROLLMENT_TTL_MS).toISOString());

    const redeemed = redeemRunnerEnrollment(f.store, f.caps as never, issued.code, NOW);
    expect(redeemed).toMatchObject({ row: { username: "alice", device: "mac" }, token: `rt_${"b".repeat(32)}` });
    expect(f.mintDeviceToken).toHaveBeenCalledOnce();
    expect(redeemRunnerEnrollment(f.store, f.caps as never, issued.code, NOW)).toBeNull();
    expect(f.mintDeviceToken).toHaveBeenCalledOnce();
    f.store.close();
  });

  it("invalidates the previous pending code for a device and rejects expiry", () => {
    const f = fixture();
    const first = issueRunnerEnrollment(f.store, "alice", "mac", NOW);
    const second = issueRunnerEnrollment(f.store, "alice", "mac", new Date(NOW.getTime() + 1));
    expect(redeemRunnerEnrollment(f.store, f.caps as never, first.code, NOW)).toBeNull();
    expect(redeemRunnerEnrollment(
      f.store,
      f.caps as never,
      second.code,
      new Date(NOW.getTime() + RUNNER_ENROLLMENT_TTL_MS + 2),
    )).toBeNull();
    expect(f.mintDeviceToken).not.toHaveBeenCalled();
    f.store.close();
  });
});
