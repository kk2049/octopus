import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReleaseStager } from "./release-stage.js";

const roots: string[] = [], services: ReleaseStager[] = [];
afterEach(async () => { for (const s of services.splice(0)) s.close(); vi.useRealTimers(); for (const p of roots.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
async function fixture(free: () => Promise<number> = async () => 20 * 1024 ** 3, busy = () => false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-stage-")); roots.push(root);
  const sha = "a".repeat(40), manifest = path.join(root, "release.json");
  await fs.writeFile(manifest, JSON.stringify({ repoSha: sha, parts: [{ bytes: 1000 }] }));
  const run = vi.fn(async (_args: string[]) => {});
  const stage = new ReleaseStager({ job: "/job", repository: root, releases: path.join(root, "trees"),
    artifacts: root, database: path.join(root, "db"), pointers: async () => ({ current: "current", previous: "previous" }),
    run, availableBytes: free, foregroundBusy: busy, idleMs: 100 });
  services.push(stage);
  return { stage, run, sha, manifest };
}
it("installs immediately and collects only after idle, never while deployment is active", async () => {
  vi.useFakeTimers(); let busy = true;
  const f = await fixture(undefined, () => busy);
  await f.stage.stage(f.manifest, f.sha, new AbortController().signal);
  expect(f.run.mock.calls.map(([a]) => a[0])).toEqual(["install"]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.run).toHaveBeenCalledTimes(1);
  busy = false; await vi.advanceTimersByTimeAsync(100);
  expect(f.run.mock.calls.map(([a]) => a[0])).toEqual(["install", "prune"]);
});
it("does one bounded cleanup on low space and refuses installation if the reserve is still unavailable", async () => {
  const f = await fixture(async () => 1000);
  await expect(f.stage.stage(f.manifest, f.sha, new AbortController().signal)).rejects.toThrow("insufficient release staging space");
  expect(f.run.mock.calls.map(([a]) => a[0])).toEqual(["prune"]);
});
it("continues after low-space cleanup restored enough headroom", async () => {
  let reads = 0;
  const f = await fixture(async () => ++reads === 1 ? 1000 : 20 * 1024 ** 3);
  await f.stage.stage(f.manifest, f.sha, new AbortController().signal);
  expect(f.run.mock.calls.map(([a]) => a[0])).toEqual(["prune", "install"]);
});
it("never treats failed installation as a reason to schedule cleanup or retry it", async () => {
  vi.useFakeTimers(); const f = await fixture();
  f.run.mockRejectedValueOnce(new Error("digest mismatch"));
  await expect(f.stage.stage(f.manifest, f.sha, new AbortController().signal)).rejects.toThrow("digest mismatch");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("runs the real job to its own exit whatever it prints, and still fails on a non-zero status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-job-")); roots.push(root);
  const job = path.join(root, "job.sh");
  // 3 MiB of output used to pass execFile's 1 MiB maxBuffer and kill the job.
  await fs.writeFile(job, 'head -c 3145728 /dev/zero | tr "\\0" x; echo; [ "$1" = install ] || exit 7\n');
  const sha = "b".repeat(40), manifest = path.join(root, "release.json");
  await fs.writeFile(manifest, JSON.stringify({ repoSha: sha, parts: [{ bytes: 1000 }] }));
  const make = (free: number) => {
    const stage = new ReleaseStager({ job, repository: root, releases: path.join(root, "trees"), artifacts: root,
      database: path.join(root, "db"), pointers: async () => ({ current: "c", previous: "p" }), availableBytes: async () => free, idleMs: 60_000 });
    services.push(stage);
    return stage;
  };
  await make(20 * 1024 ** 3).stage(manifest, sha, new AbortController().signal);
  // Low space runs `prune` first, which this job answers with exit 7.
  await expect(make(1000).stage(manifest, sha, new AbortController().signal)).rejects.toMatchObject({ code: 7 });
});
