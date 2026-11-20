import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./canonical.js";
import { AppStateService, SNAPSHOT_RETENTION_PER_DIGEST, type FaultPoint } from "./service.js";
import { STATE_READ_PAGE_LIMIT, type CommitRequest } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "app-state-"));
  roots.push(dir);
  return dir;
}

function request(streamId: string, revision: number, dispatchId = randomUUID()): CommitRequest {
  return {
    streamId,
    expectedRevision: revision,
    dispatchId,
    actor: "session-plus",
    action: "pin_session",
    paramsHash: "p".repeat(64),
    backendCodeDigest: "b".repeat(64),
    contractDigest: "c".repeat(64),
    events: [{ type: "session_pinned", data: { session: "demo-1" }, at: "2026-08-04T00:00:00.000Z", by: "session-plus" }],
  };
}

describe("AppStateService", () => {
  it("re-asserts private directory and database modes on startup", () => {
    const dir = root();
    chmodSync(dir, 0o755);
    const service = new AppStateService(dir);
    const mode = (file: string) => statSync(file).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "streams"))).toBe(0o700);
    expect(mode(join(dir, "state.db"))).toBe(0o600);
    service.close();
  });

  it("keeps a stable opaque stream mapping across restart", () => {
    const dir = root();
    const first = new AppStateService(dir);
    const a = first.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    expect(a.streamId).toMatch(/^st_[0-9a-f]{32}$/);
    expect(a.streamId).not.toContain("alice");
    first.close();
    const second = new AppStateService(dir);
    expect(second.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } })).toEqual(a);
    second.close();
  });

  it("appends immutable events, rejects stale heads and deduplicates dispatches", () => {
    const service = new AppStateService(root());
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    const dispatch = randomUUID();
    expect(service.commit(request(stream.streamId, 0, dispatch))).toEqual({ ok: true, revision: 1, duplicate: false });
    expect(service.commit(request(stream.streamId, 0, dispatch))).toEqual({ ok: true, revision: 1, duplicate: true });
    expect(service.commit(request(stream.streamId, 0))).toEqual({ ok: false, code: "conflict", head: 1 });
    expect(service.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT)).toMatchObject({
      head: 1,
      cursor: 1,
      hasMore: false,
      events: [{ seq: 1, type: "session_pinned", data: { session: "demo-1" } }],
    });
    service.close();
  });

  it("pages raw events below the child-rpc ceiling and points oversized callers at snapshots", () => {
    const service = new AppStateService(root());
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    const commit = request(stream.streamId, 0);
    commit.events = Array.from({ length: STATE_READ_PAGE_LIMIT + 4 }, (_, index) => ({
      type: "session_pinned",
      data: { session: `demo-${index}` },
      at: "2026-08-04T00:00:00.000Z",
      by: "session-plus",
    }));
    expect(service.commit(commit)).toMatchObject({ ok: true, revision: STATE_READ_PAGE_LIMIT + 4 });
    const first = service.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT);
    expect(first).toMatchObject({ cursor: STATE_READ_PAGE_LIMIT, hasMore: true, head: STATE_READ_PAGE_LIMIT + 4 });
    expect(first.events).toHaveLength(STATE_READ_PAGE_LIMIT);
    expect(service.readSince(stream.streamId, first.cursor, STATE_READ_PAGE_LIMIT)).toMatchObject({
      cursor: STATE_READ_PAGE_LIMIT + 4,
      hasMore: false,
      events: expect.arrayContaining([expect.objectContaining({ seq: STATE_READ_PAGE_LIMIT + 4 })]),
    });
    expect(() => service.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT + 1)).toThrow(/snapshots/);
    service.close();
  });

  it("pages the commit chain as evidence summaries, never raw params or payloads", () => {
    const service = new AppStateService(root());
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    for (let revision = 0; revision < 3; revision++) {
      const commit = request(stream.streamId, revision);
      commit.actor = revision === 2 ? "agent:demo/mcp@alice" : "session-plus";
      service.commit(commit);
    }
    const first = service.readCommits(stream.streamId, 0, 2);
    expect(first.head).toBe(3);
    expect(first.commits).toHaveLength(2);
    expect(first.commits[0]).toMatchObject({
      seqFrom: 1,
      seqTo: 1,
      at: "2026-08-04T00:00:00.000Z",
      actor: "session-plus",
      action: "pin_session",
      paramsHash: "p".repeat(64),
      backendCodeDigest: "b".repeat(64),
      contractDigest: "c".repeat(64),
      eventCount: 1,
    });
    // The page after the first one starts where it ended, and carries the
    // agent-authored actor verbatim.
    const rest = service.readCommits(stream.streamId, first.commits[1]!.seqTo, 10);
    expect(rest.commits.map((commit) => commit.seqFrom)).toEqual([3]);
    expect(rest.commits[0]!.actor).toBe("agent:demo/mcp@alice");
    // Event payloads stay in the store: the summary carries a count only.
    expect(JSON.stringify(first)).not.toContain("demo-1");
    service.close();
  });

  it("refuses out-of-bounds commit pages instead of clamping them", () => {
    const service = new AppStateService(root());
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    expect(() => service.readCommits(stream.streamId, 0, 0)).toThrow(/limit/);
    expect(() => service.readCommits(stream.streamId, 0, 257)).toThrow(/limit/);
    expect(() => service.readCommits(stream.streamId, -1, 10)).toThrow(/revision/);
    expect(() => service.readCommits("st_" + "f".repeat(32), 0, 10)).toThrow(/not found/);
    expect(service.readCommits(stream.streamId, 0, 256)).toEqual({ commits: [], head: 0 });
    service.close();
  });

  it.each(["after_rename", "before_db_commit"] as FaultPoint[])(
    "adopts a fully fsynced commit after a %s failure without duplicating it",
    (point) => {
      const dir = root();
      let armed = true;
      const service = new AppStateService(dir, { fault(at) { if (armed && at === point) { armed = false; throw new Error("injected crash window"); } } });
      const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
      const dispatch = randomUUID();
      expect(service.commit(request(stream.streamId, 0, dispatch))).toEqual({ ok: true, revision: 1, duplicate: true });
      expect(service.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT).events).toHaveLength(1);
      service.close();
    },
  );

  it("does not adopt a commit that was fsynced only as a temporary file", () => {
    const dir = root();
    let armed = true;
    const service = new AppStateService(dir, {
      fault(point) {
        if (armed && point === "after_file_fsync") {
          armed = false;
          throw new Error("injected pre-rename failure");
        }
      },
    });
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    expect(() => service.commit(request(stream.streamId, 0))).toThrow(/injected pre-rename failure/);
    expect(service.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT)).toEqual({
      events: [], head: 0, cursor: 0, hasMore: false,
    });
    const commits = join(dir, "streams", stream.streamId.slice(3, 5), stream.streamId, "commits");
    expect(readdirSync(commits)).toEqual([]);
    service.close();
  });

  it("rebuilds a deleted SQLite index from immutable manifests and commits", () => {
    const dir = root();
    const first = new AppStateService(dir);
    const stream = first.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    first.commit(request(stream.streamId, 0));
    first.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(join(dir, `state.db${suffix}`)); } catch { /* absent */ }
    }
    const rebuilt = new AppStateService(dir);
    expect(rebuilt.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } })).toEqual({
      streamId: stream.streamId,
      head: 1,
    });
    expect(rebuilt.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT).events).toHaveLength(1);
    rebuilt.close();
  });

  it("restarts from the verified index without replaying older commits, yet refuses them when read", () => {
    const dir = root();
    const first = new AppStateService(dir);
    const stream = first.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    for (let revision = 0; revision < 3; revision++) first.commit(request(stream.streamId, revision));
    first.close();
    const commits = join(dir, "streams", stream.streamId.slice(3, 5), stream.streamId, "commits");
    const oldest = join(commits, readdirSync(commits).sort()[0]!);
    writeFileSync(oldest, readFileSync(oldest, "utf8").replace("demo-1", "demo-X"), "utf8");
    const reopened = new AppStateService(dir);
    expect(reopened.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } }).head).toBe(3);
    expect(() => reopened.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT)).toThrow(/hash mismatch/);
    expect(reopened.readSince(stream.streamId, 1, STATE_READ_PAGE_LIMIT).events).toHaveLength(2);
    reopened.close();
  });

  it("refuses an older commit replaced by a self-consistent one when it is read", () => {
    const dir = root();
    const first = new AppStateService(dir);
    const stream = first.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    for (let revision = 0; revision < 2; revision++) first.commit(request(stream.streamId, revision));
    first.close();
    const commits = join(dir, "streams", stream.streamId.slice(3, 5), stream.streamId, "commits");
    const oldest = join(commits, readdirSync(commits).sort()[0]!);
    const { commitHash: _hash, ...base } = JSON.parse(readFileSync(oldest, "utf8")) as Record<string, unknown>;
    const forged = { ...base, actor: "someone-else" };
    writeFileSync(oldest, canonicalJson({ ...forged, commitHash: sha256(canonicalJson(forged)) }), "utf8");
    const reopened = new AppStateService(dir);
    expect(() => reopened.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT)).toThrow(/no longer matches its index/);
    reopened.close();
  });

  it("adopts a later commit that crashed between rename and index commit", () => {
    const dir = root();
    let armed = false;
    const service = new AppStateService(dir, { fault(at) { if (armed && at === "after_rename") { armed = false; throw new Error("injected crash window"); } } });
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    service.commit(request(stream.streamId, 0));
    armed = true;
    expect(service.commit(request(stream.streamId, 1))).toEqual({ ok: true, revision: 2, duplicate: true });
    service.close();
    const reopened = new AppStateService(dir);
    expect(reopened.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT).events).toHaveLength(2);
    expect(reopened.commit(request(stream.streamId, 2))).toMatchObject({ ok: true, revision: 3 });
    reopened.close();
  });

  it("rebuilds from the files when the index no longer names the oldest commits", () => {
    const dir = root();
    const first = new AppStateService(dir);
    const stream = first.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    for (let revision = 0; revision < 3; revision++) first.commit(request(stream.streamId, revision));
    first.close();
    const db = new Database(join(dir, "state.db"));
    db.prepare("DELETE FROM commits WHERE stream_id = ? AND seq_from = 1").run(stream.streamId);
    db.close();
    const rebuilt = new AppStateService(dir);
    expect(rebuilt.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT).events).toHaveLength(3);
    rebuilt.close();
  });

  it("refuses a changed immutable commit instead of silently discarding history", () => {
    const dir = root();
    const first = new AppStateService(dir);
    const stream = first.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    first.commit(request(stream.streamId, 0));
    first.close();
    const commits = join(dir, "streams", stream.streamId.slice(3, 5), stream.streamId, "commits");
    const file = readdirSync(commits).find((name) => name.endsWith(".json"))!;
    const body = readFileSync(join(commits, file), "utf8");
    writeFileSync(join(commits, file), body.replace("demo-1", "demo-X"), "utf8");
    expect(() => new AppStateService(dir)).toThrow(/hash mismatch/);
  });

  it("treats snapshots as replaceable caches keyed by projection digest", () => {
    const service = new AppStateService(root());
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    service.commit(request(stream.streamId, 0));
    const digest = "d".repeat(64);
    service.putSnapshot(stream.streamId, 1, digest, { pinned: ["demo-1"] });
    expect(service.snapshot(stream.streamId, digest)).toEqual({ revision: 1, view: { pinned: ["demo-1"] } });
    expect(service.snapshot(stream.streamId, "e".repeat(64))).toBeNull();
    const rows = Array.from({ length: 25_000 }, (_, index) => index);
    service.putSnapshot(stream.streamId, 1, digest, { rows });
    expect(service.snapshot(stream.streamId, digest)).toEqual({ revision: 1, view: { rows } });
    service.close();
  });

  it("indexes snapshots, retains the newest N per digest and rebuilds that index on recovery", () => {
    const dir = root();
    const service = new AppStateService(dir);
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    const digest = "d".repeat(64);
    for (let revision = 0; revision < SNAPSHOT_RETENTION_PER_DIGEST + 2; revision++) {
      service.commit(request(stream.streamId, revision));
      service.putSnapshot(stream.streamId, revision + 1, digest, { revision: revision + 1 });
    }
    const snapshots = join(dir, "streams", stream.streamId.slice(3, 5), stream.streamId, "snapshots");
    expect(readdirSync(snapshots).filter((name) => name.endsWith(`-${digest}.json.gz`))).toHaveLength(
      SNAPSHOT_RETENTION_PER_DIGEST,
    );
    expect(service.snapshot(stream.streamId, digest)).toEqual({
      revision: SNAPSHOT_RETENTION_PER_DIGEST + 2,
      view: { revision: SNAPSHOT_RETENTION_PER_DIGEST + 2 },
    });
    service.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(join(dir, `state.db${suffix}`)); } catch { /* absent */ }
    }
    const rebuilt = new AppStateService(dir);
    expect(rebuilt.snapshot(stream.streamId, digest)).toEqual({
      revision: SNAPSHOT_RETENTION_PER_DIGEST + 2,
      view: { revision: SNAPSHOT_RETENTION_PER_DIGEST + 2 },
    });
    rebuilt.close();
  });

  it("recovers immutable history when the disposable snapshot directory is deleted", () => {
    const dir = root();
    const service = new AppStateService(dir);
    const stream = service.resolveStream({ app: "session-plus", scope: { kind: "account", key: "alice" } });
    service.commit(request(stream.streamId, 0));
    service.putSnapshot(stream.streamId, 1, "d".repeat(64), { cached: true });
    service.close();
    rmSync(join(dir, "streams", stream.streamId.slice(3, 5), stream.streamId, "snapshots"), { recursive: true });

    const rebuilt = new AppStateService(dir);
    expect(rebuilt.snapshot(stream.streamId, "d".repeat(64))).toBeNull();
    expect(rebuilt.readSince(stream.streamId, 0, STATE_READ_PAGE_LIMIT).events).toHaveLength(1);
    rebuilt.close();
  });
});
