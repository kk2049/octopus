import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexSessionRoots } from "./codex-session-roots.js";
import { listRecentSessions, readSession } from "@claude-bot/plugin-sessions/scan";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-session-roots-"));
  temporary.push(home);
  const seed = async (relative: string, id: string) => {
    const root = path.join(home, relative);
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({
      type: "session_meta", payload: { id, cwd: home, source: "exec" },
    }));
    return root;
  };
  return { home, seed };
}

describe("Codex session root discovery", () => {
  it("reuses unchanged historical roots after the discovery interval", async () => {
    const { home, seed } = await fixture();
    const history = await Promise.all(Array.from({ length: 30 }, (_, n) => seed(`worker-${n}`, `id-${n}`)));
    let now = 10_000;
    const discovery = new CodexSessionRoots({ home, codexHome: path.join(home, ".codex"), discover: async () => history.slice(0, 1), now: () => now });
    await fs.mkdir(path.join(home, ".octopus"), { recursive: true });
    await fs.writeFile(path.join(home, ".octopus", "session-scan-roots.json"), JSON.stringify(history));
    const before = await discovery.refresh(); const realpath = vi.spyOn(fs, "realpath");
    try { now += 4_000; expect(await discovery.refresh()).toBe(before); expect(realpath.mock.calls.length).toBeLessThan(10); }
    finally { realpath.mockRestore(); }
  });
  it("does not revalidate history when a live worker exits or another root appears", async () => {
    const { home, seed } = await fixture();
    const history = await Promise.all(Array.from({ length: 30 }, (_, n) => seed(`worker-${n}`, `id-${n}`)));
    let now = 10_000; let live = history.slice(0, 1);
    await fs.mkdir(path.join(home, ".octopus"), { recursive: true });
    await fs.writeFile(path.join(home, ".octopus", "session-scan-roots.json"), JSON.stringify(history));
    const discovery = new CodexSessionRoots({ home, codexHome: path.join(home, ".codex"), discover: async () => live, now: () => now });
    const before = await discovery.refresh(); const realpath = vi.spyOn(fs, "realpath");
    try {
      live = []; now += 4_000; expect(await discovery.refresh()).toBe(before);
      expect(realpath.mock.calls.length).toBeLessThan(10); realpath.mockClear();
      live = [await seed("new-worker", "new")]; now += 4_000;
      expect((await discovery.refresh()).codexHomes?.map((root) => root.codexHome)).toContain(live[0]);
      expect(realpath.mock.calls.length).toBeLessThan(10);
    } finally { realpath.mockRestore(); }
  });
  it("adds a/b profiles and observed app-server homes without removing the default or effective home", async () => {
    const { home, seed } = await fixture();
    const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    const base = await seed(".codex", id(1));
    const a = await seed(".codex-accounts/account-a", id(2));
    const b = await seed(".codex-accounts/account-b", id(3));
    const custom = await seed("project/app-server-home", id(4));
    const discovery = new CodexSessionRoots({ home, codexHome: a, discover: async () => [custom] });
    const roots = await discovery.refresh();
    expect(roots.codexHomes?.map((row) => row.codexHome)).toEqual([a, b, base, custom]);
    const listed = await listRecentSessions(roots, { limit: 20 }) as { sessions: Array<{ id: string }> };
    expect(listed.sessions.map((row) => row.id).sort()).toEqual([id(1), id(2), id(3), id(4)]);
    expect(await readSession(roots, { id: id(4), source: "codex" })).toMatchObject({ meta: { id: id(4) } });
    // Finishing the headless process and restarting Runner does not erase its history.
    const restarted = new CodexSessionRoots({ home, codexHome: base, discover: async () => [] });
    expect((await restarted.refresh()).codexHomes?.map((row) => row.codexHome)).toContain(custom);
  });

  it("keeps configured account labels and deduplicates canonical homes", async () => {
    const { home, seed } = await fixture();
    const a = await seed(".codex-accounts/account-a", "a");
    const alias = path.join(home, "alias");
    await symlink(a, alias, "dir");
    const roots = await new CodexSessionRoots({ home, codexHome: alias,
      accounts: [{ label: "b", codexHome: a }], discover: async () => [a, alias] }).refresh();
    expect(roots.codexHomes?.filter((row) => row.codexHome === a)).toEqual([{ label: "b", codexHome: a }]);
  });

  it("lists an explicitly linked migrated account without admitting arbitrary outside homes", async () => {
    const { home, seed } = await fixture();
    const base = await seed(".codex", "default");
    const other = await fixture();
    const migrated = await other.seed(".codex", "migrated");
    const unregistered = await other.seed("unregistered", "unregistered");
    const alias = path.join(home, ".codex-accounts", "account-d");
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(migrated, alias, "dir");
    let now = 10_000;
    const discovery = new CodexSessionRoots({ home, codexHome: base,
      discover: async () => [unregistered], now: () => now });
    expect((await discovery.refresh()).codexHomes).toEqual([
      { label: "d", codexHome: migrated }, { label: "", codexHome: base },
    ]);
    // The alias is a live local registration, not durable discovery authority.
    await fs.unlink(alias); now += 4_000;
    expect((await discovery.refresh()).codexHomes).toEqual([{ label: "", codexHome: base }]);
  });

  it("refuses conventional aliases into split homes or escaped sessions directories", async () => {
    const { home, seed } = await fixture();
    const base = await seed(".codex", "default");
    const other = await fixture();
    const split = await other.seed(".octopus/codex-split-home/account", "private");
    const outside = await other.seed("outside", "outside");
    const indirect = path.join(home, "indirect"); await mkdir(indirect);
    await symlink(path.join(outside, "sessions"), path.join(indirect, "sessions"));
    const directory = path.join(home, ".codex-accounts"); await mkdir(directory);
    await symlink(split, path.join(directory, "account-c"));
    await symlink(indirect, path.join(directory, "account-d"));
    expect((await new CodexSessionRoots({ home, codexHome: base, discover: async () => [] }).refresh()).codexHomes)
      .toEqual([{ label: "", codexHome: base }]);
  });

  it("rejects outside-home discoveries and every alias into the private split corpus", async () => {
    const { home, seed } = await fixture();
    const other = await fixture();
    const outside = await other.seed("private", "outside");
    const split = await seed(".octopus/codex-split-home", "relay");
    const alias = path.join(home, "split-alias");
    await symlink(split, alias, "dir");
    const indirect = path.join(home, "indirect");
    await mkdir(indirect);
    await symlink(path.join(split, "sessions"), path.join(indirect, "sessions"), "dir");
    const roots = await new CodexSessionRoots({ home, codexHome: path.join(home, ".codex"),
      discover: async () => [outside, split, alias, indirect] }).refresh();
    expect(roots.codexHomes).toEqual([{ label: "", codexHome: path.join(home, ".codex") }]);
  });
});
