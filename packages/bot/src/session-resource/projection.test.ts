import { describe, expect, it } from "vitest";
import {
  MAX_PROJECTED_TRANSCRIPTS,
  mergeTranscriptTail,
  prependTranscriptWindow,
  publicSession,
  publicTranscript,
  publicRuntime,
  publicWorkspaceSnapshot,
  reconcileTranscriptWindows,
  retainTranscripts,
} from "./projection.js";

describe("publicSession", () => {
  it("projects only observed Codex turn identifiers and explicitly clears missing facts", () => {
    const decoded = { device: "laptop", cliKind: "codex", sessionId: "one" };
    const raw = { meta: { turn_configuration: { model: "gpt-6-luna", effort: "high", auth: "secret", cwd: "/private" } } };
    const projected = publicTranscript(raw, decoded);
    expect(projected.turnConfiguration).toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(JSON.stringify(projected)).not.toMatch(/private|secret|auth/);
    expect(publicTranscript({}, decoded).turnConfiguration).toBeNull();
    expect(publicTranscript({ meta: { turn_configuration: { model: "x".repeat(121), effort: [] } } }, decoded).turnConfiguration).toBeNull();
    expect(publicTranscript(raw, { ...decoded, cliKind: "claude" })).not.toHaveProperty("turnConfiguration");
    expect(mergeTranscriptTail({ ...projected, offset: 0, totalMessages: 1, messages: [{ role: "user", text: "hi" }] },
      { ...publicTranscript({}, decoded), offset: 0, totalMessages: 1, messages: [{ role: "user", text: "hi" }] })).toHaveProperty("turnConfiguration", null);
  });

  it("projects only bounded capacity status, never checkpoint identities or native errors", () => {
    const runtime = publicRuntime({ process_state: "alive", recovery: { state: "waiting_capacity", attempts: 2,
      max_attempts: 100, deadline_at: "2026-09-24T12:30:00Z", checkpoint: { token: "secret" }, codexHome: "/private/account-d",
      providerError: { message: "private native details" } } });
    expect(runtime?.recovery).toMatchObject({ state: "waiting_capacity", attempts: 2, max_attempts: 6, deadline_at: "2026-09-24T12:30:00Z" });
    expect(JSON.stringify(runtime)).not.toMatch(/secret|private|checkpoint|codexHome|providerError/);
  });
  it("publishes bounded recovery state without private journal or dependency coordinates", () => {
    const runtime = publicRuntime({ process_state: "unknown", recovery: { state: "waiting_resource",
      since: "2026-09-16T00:00:00Z", retry_at: "2026-09-16T00:01:30Z", resource: "runner:alice/private",
      checkpoint: { token: "secret" }, detail: "/private/codex/auth.json" } });
    expect(runtime?.recovery).toEqual({ state: "waiting_resource", since: "2026-09-16T00:00:00Z", retry_at: "2026-09-16T00:01:30Z" });
    expect(JSON.stringify(runtime)).not.toMatch(/alice|private|secret|checkpoint|"resource"/);
  });
  it("projects only the compact account marker", () => {
    const entry = {
      resourceId: "opaque",
      owner: "alice",
      deviceId: "laptop",
      deviceLabel: "laptop",
      cliKind: "codex",
      sessionId: "session-1",
      accountLabel: "b",
      status: "idle",
      resumable: true,
      id: "session-1",
      source: "codex",
      device: "laptop",
    } as const;
    const projected = publicSession(entry);
    expect(projected.accountLabel).toBe("b");
    expect(JSON.stringify(projected)).not.toMatch(/account[_-]?b|CODEX_HOME|\/srv\//i);
    expect(publicSession({ ...entry, accountLabel: "private-slot" })).not.toHaveProperty("accountLabel");
    expect(projected).not.toHaveProperty("messageCount");
    expect(publicSession({ ...entry, message_count: 0 })).toHaveProperty("messageCount", 0);
    expect(publicSession({ ...entry, message_count: 946 })).toHaveProperty("messageCount", 946);
  });

  it("projects only bounded stable-order and completion timestamps", () => {
    const entry = {
      resourceId: "opaque",
      owner: "alice",
      deviceId: "laptop",
      deviceLabel: "laptop",
      cliKind: "claude",
      sessionId: "session-1",
      status: "idle",
      resumable: true,
      id: "session-1",
      source: "claude",
      device: "laptop",
      sortActivity: "2026-08-25T10:00:00Z",
      completedAt: "2026-08-25T10:05:00Z",
    } as const;
    expect(publicSession(entry)).toMatchObject({
      sortActivity: "2026-08-25T10:00:00Z",
      completedAt: "2026-08-25T10:05:00Z",
    });
  });

  it("projects the directory device but never the internal workspace coordinate", () => {
    const projected = publicSession({
      resourceId: "opaque",
      owner: "alice",
      deviceId: "runtime-a",
      deviceLabel: "runtime-a",
      directoryDeviceId: "exec-b",
      directoryWorkspaceId: "ws_0123456789abcdef01234567",
      cliKind: "codex",
      sessionId: "session-1",
      status: "idle",
      resumable: true,
      id: "session-1",
      source: "codex",
      device: "runtime-a",
    });
    expect(projected).toMatchObject({ deviceId: "runtime-a", directoryDeviceId: "exec-b" });
    expect(projected).not.toHaveProperty("directoryWorkspaceId");
    expect(JSON.stringify(projected)).not.toContain("ws_0123456789abcdef01234567");
  });

  it("projects only a complete parent-owned navigation claim", () => {
    const entry = {
      resourceId: "child-resource",
      owner: "alice",
      deviceId: "laptop",
      deviceLabel: "laptop",
      cliKind: "codex",
      sessionId: "thread-child",
      status: "idle",
      resumable: false,
      inputMode: "parent_owned",
      parentResourceId: "parent-resource",
      id: "thread-child",
      source: "codex",
      device: "laptop",
    } as const;
    expect(publicSession(entry)).toMatchObject({
      inputMode: "parent_owned",
      parentResourceId: "parent-resource",
      resumable: false,
    });
    expect(publicSession({ ...entry, parentResourceId: undefined })).not.toHaveProperty("inputMode");
    expect(publicSession({ ...entry, inputMode: undefined })).toHaveProperty("parentResourceId", "parent-resource");
    expect(publicSession({ ...entry, inputMode: undefined })).not.toHaveProperty("inputMode");
  });
});

describe("publicWorkspaceSnapshot", () => {
  it("applies the sessions label/display rules after the shared raw parser", () => {
    const long = `  ${"x".repeat(150)}  `;
    const projected = publicWorkspaceSnapshot({
      device: "laptop",
      roots: [
        { workspaceId: "ws_0123456789abcdef01234567", label: long, display: " ~/demo " },
        // Valid for workspace-files/v1, but the sessions launch row requires a
        // display path and therefore continues to omit this root.
        { workspaceId: "ws_1123456789abcdef01234567", label: "files-only" },
      ],
      sessionDirectories: [],
    });
    const rows = projected.workspaces as unknown as Array<Record<string, string>>;
    expect(rows).toEqual([{
      id: "ws_0123456789abcdef01234567",
      label: "x".repeat(118),
      display: "~/demo",
    }]);
  });
});

describe("retainTranscripts", () => {
  it("evicts the least recently touched window and never the window just added", () => {
    const previous = Object.fromEntries(
      Array.from({ length: MAX_PROJECTED_TRANSCRIPTS }, (_, index) => [`resource-${index}`, { index }]),
    );

    const retained = retainTranscripts(previous, "resource-new", { index: 99 });

    expect(Object.keys(retained)).toEqual([
      ...Array.from({ length: MAX_PROJECTED_TRANSCRIPTS - 1 }, (_, index) => `resource-${index + 1}`), "resource-new",
    ]);
    expect(retained["resource-new"]).toEqual({ index: 99 });
  });

  it("moves an existing window to most-recent without discarding another window", () => {
    const retained = retainTranscripts({
      oldest: { version: 1 },
      selected: { version: 1 },
      middle: { version: 1 },
      newest: { version: 1 },
    }, "selected", { version: 2 });

    expect(Object.keys(retained)).toEqual(["oldest", "middle", "newest", "selected"]);
    expect(retained.selected).toEqual({ version: 2 });
  });

  it("shrinks an oversized legacy map to the same bound", () => {
    const entries = Array.from({ length: MAX_PROJECTED_TRANSCRIPTS + 2 }, (_, index) => [`window-${index}`, {}] as const);
    const retained = retainTranscripts(Object.fromEntries(entries), "fresh", {});
    expect(Object.keys(retained)).toEqual([...entries.slice(3).map(([key]) => key), "fresh"]);
    expect(Object.keys(retained)).toHaveLength(MAX_PROJECTED_TRANSCRIPTS);
  });
});

describe("transcript freshness", () => {
  const version = (sequence: number, epoch = "runner-epoch-one") => ({ epoch, sequence });
  const window = (offset: number, totalMessages: number, labels: string[], sequence?: number) => ({
    offset,
    totalMessages,
    messages: labels.map((label) => ({ label })),
    ...(sequence === undefined ? {} : { version: version(sequence) }),
  });

  it("projects only a valid materialized source version", () => {
    expect(publicTranscript({
      rich: true,
      messages: [],
      projection_version: version(9),
      forged: { epoch: "secret", sequence: 100 },
    }, { device: "laptop", cliKind: "codex", sessionId: "s-1" })).toMatchObject({
      version: version(9),
    });
    expect(publicTranscript({
      rich: true,
      messages: [],
      projection_version: { epoch: "bad", sequence: 9 },
    }, { device: "laptop", cliKind: "codex", sessionId: "s-1" })).not.toHaveProperty("version");
  });

  it("keeps a newer tail when an older same-epoch window arrives in a later frame", () => {
    const current = window(8, 10, ["eight", "done"], 9);
    const stale = window(0, 9, ["zero", "one"], 8);
    expect(reconcileTranscriptWindows(current, stale)).toEqual(current);
    expect(mergeTranscriptTail(current, stale)).toEqual(current);
  });

  it("lets history extend left without replacing the current overlapping suffix", () => {
    const current = window(8, 10, ["current-eight", "current-nine"], 9);
    const older = window(6, 10, ["six", "seven"], 8);
    expect(prependTranscriptWindow(current, older)).toMatchObject({
      offset: 6,
      totalMessages: 10,
      version: version(9),
      messages: [
        { label: "six" },
        { label: "seven" },
        { label: "current-eight" },
        { label: "current-nine" },
      ],
    });
  });

  it("accepts same-frontier rewrites from a newer version and real epoch resets", () => {
    const current = window(8, 10, ["tool-running", "waiting"], 9);
    const completed = window(8, 10, ["tool-complete", "done"], 10);
    expect(reconcileTranscriptWindows(current, completed)).toMatchObject({
      version: version(10),
      messages: [{ label: "tool-complete" }, { label: "done" }],
    });

    const reset = window(0, 1, ["rewritten"], 1);
    reset.version = version(1, "runner-epoch-two");
    expect(reconcileTranscriptWindows(completed, reset)).toEqual(reset);
  });
});
