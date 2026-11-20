/**
 * What this contract is allowed to say, and what it must not grow.
 *
 * A vocabulary test looks trivial until the day somebody adds a method. These
 * three assertions are the ones that would fail first: a port method that leaks
 * an identity, an action id that drifts from what the Host binds, and an
 * operation map that quietly starts claiming a Gate token nobody grants.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_PERMISSION_PROFILES,
  AGENT_SESSIONS_CONTRACT,
  READ_ONLY_REFUSAL,
  SESSION_ACTIONS,
  SESSION_CLI_KINDS,
  SESSION_OPERATION_FIELDS,
  SESSION_OPERATIONS,
  compareTranscriptVersions,
  operationOutcomePhase,
  reconcileTranscriptWindows,
  transcriptVersionOf,
  type SessionSummary,
  type SessionsPort,
} from "./index.js";

describe("agent-sessions/v1", () => {
  it("names itself with the version in the id", () => {
    expect(AGENT_SESSIONS_CONTRACT).toBe("agent-sessions/v1");
  });

  it("shares one closed permission vocabulary across providers", () => {
    expect(AGENT_PERMISSION_PROFILES).toEqual({ fullAccess: "full_access", manual: "manual" });
  });

  it("owns the closed CLI kind vocabulary shared by hosts and providers", () => {
    expect(SESSION_CLI_KINDS).toEqual(["claude", "codex", "omp"]);
  });

  it("has exactly the action ids the trusted coordinator binds", () => {
    expect(Object.values(SESSION_ACTIONS).sort()).toEqual([
      "append_session",
      "attach_file",
      "close_session",
      "close_terminal",
      "delete_session_folder",
      "fallback_session",
      "file_sessions",
      "interrupt_session",
      "open_session",
      "open_terminal",
      "pin_session",
      "read_codex_continuation",
      "read_terminal",
      "refresh_sessions",
      "refresh_workspaces",
      "release_session_control",
      "respond_agent_interaction",
      "resume_session",
      "review_session",
      "save_codex_continuation",
      "save_session_folder",
      "search_sessions",
      "send_terminal",
      "set_file_annotations",
      "set_session_title",
      "start_session",
      "takeover_session",
    ]);
  });

  it("exports the closed operation projection allowlist adapters copy", () => {
    expect(SESSION_OPERATION_FIELDS).toEqual([
      "id",
      "status",
      "input",
      "recovery",
      "message",
      "detail",
      "operation",
      "resourceId",
      "sessionId",
      "newResourceId",
    ]);
  });

  it("maps every machine/resource action to a Gate operation, excluding App state, read teardown and one-shot answers", () => {
    const mapped = Object.keys(SESSION_OPERATIONS).sort();
    const actions = Object.values(SESSION_ACTIONS)
      .filter((id) =>
        id !== SESSION_ACTIONS.closeSession
        && id !== SESSION_ACTIONS.pin
        && id !== SESSION_ACTIONS.saveFolder
        && id !== SESSION_ACTIONS.deleteFolder
        && id !== SESSION_ACTIONS.fileSessions
        && id !== SESSION_ACTIONS.setTitle
        && id !== SESSION_ACTIONS.markReviewed
        && id !== SESSION_ACTIONS.setFileAnnotations
        && id !== SESSION_ACTIONS.respondInteraction)
      .sort();
    expect(mapped).toEqual(actions);
    // Conversation, file upload, and the approved terminal open + leased use.
    expect([...new Set(Object.values(SESSION_OPERATIONS))].sort()).toEqual([
      "append_session",
      "list_recent_sessions",
      "list_session_workspaces",
      "open_workspace_terminal",
      "read_session",
      "search_sessions",
      "start_session",
      "upload_session_file",
      "workspace_terminal",
    ]);
    // Resuming an idle session is the same persistent authorisation as append.
    expect(SESSION_OPERATIONS.resume_session).toBe(SESSION_OPERATIONS.append_session);
    expect(SESSION_OPERATIONS.takeover_session).toBe(SESSION_OPERATIONS.append_session);
    expect(SESSION_OPERATIONS.fallback_session).toBe(SESSION_OPERATIONS.append_session);
    expect(SESSION_OPERATIONS.interrupt_session).toBe(SESSION_OPERATIONS.append_session);
    expect(SESSION_OPERATIONS.release_session_control).toBe(SESSION_OPERATIONS.append_session);
  });

  it("exposes no method that could tell a module who it is drawing for", () => {
    // The type is erased at runtime, so this pins the SHAPE a test double must
    // satisfy — adding `owner()` or `capability()` to the interface breaks it,
    // which is the moment somebody has to explain why.
    const surface: Record<keyof SessionsPort, true> = {
      snapshot: true,
      subscribe: true,
      clearRefusal: true,
      refreshSessions: true,
      browseSessions: true,
      search: true,
      readWindow: true,
      readBlock: true,
      closeSession: true,
      listWorkspaces: true,
      attachFile: true,
      start: true,
      append: true,
      resume: true,
      takeover: true,
      fallback: true,
      interrupt: true,
      releaseControl: true,
      respondInteraction: true,
      pin: true,
      setTitle: true,
      readContinuation: true,
      saveContinuation: true,
      markReviewed: true,
      setFileAnnotations: true,
      setPinned: true,
      saveFolder: true,
      deleteFolder: true,
      fileSessions: true,
      openShare: true,
      openTerminal: true,
      readTerminal: true,
      sendTerminal: true,
      closeTerminal: true,
    };
    expect(Object.keys(surface).sort()).toEqual([
      "append",
      "attachFile",
      "browseSessions",
      "clearRefusal",
      "closeSession",
      "closeTerminal",
      "deleteFolder",
      "fallback",
      "fileSessions",
      "interrupt",
      "listWorkspaces",
      "markReviewed",
      "openShare",
      "openTerminal",
      "pin",
      "readBlock",
      "readContinuation",
      "readTerminal",
      "readWindow",
      "refreshSessions",
      "releaseControl",
      "respondInteraction",
      "resume",
      "saveContinuation",
      "saveFolder",
      "search",
      "sendTerminal",
      "setFileAnnotations",
      "setPinned",
      "setTitle",
      "snapshot",
      "start",
      "subscribe",
      "takeover",
    ]);
  });

  it("ships a read-only refusal that reads like an answer, not a crash", () => {
    expect(READ_ONLY_REFUSAL.ok).toBe(false);
    expect(READ_ONLY_REFUSAL.code).toBe("read_only");
    expect(READ_ONLY_REFUSAL.message).toContain("只读");
  });

  it("expresses device absence as an optional display fact", () => {
    const current: SessionSummary = { resourceId: "current" };
    const retained: SessionSummary = { resourceId: "retained", stale: true };
    expect(current.stale).toBeUndefined();
    expect(retained.stale).toBe(true);
  });

  it("orders transcript versions only inside one source epoch", () => {
    const current = { epoch: "runner-epoch-one", sequence: 7 };
    expect(compareTranscriptVersions(current, { ...current, sequence: 6 })).toBe("older");
    expect(compareTranscriptVersions(current, current)).toBe("same");
    expect(compareTranscriptVersions(current, { ...current, sequence: 8 })).toBe("newer");
    expect(compareTranscriptVersions(current, { epoch: "runner-epoch-two", sequence: 1 })).toBe("reset");
    expect(compareTranscriptVersions(current, undefined)).toBe("older");
    expect(compareTranscriptVersions(undefined, current)).toBe("newer");
    expect(compareTranscriptVersions(undefined, undefined)).toBe("unknown");
    expect(transcriptVersionOf({ epoch: "short", sequence: 1 })).toBeNull();
    expect(transcriptVersionOf({ epoch: "runner-epoch-one", sequence: 1.5 })).toBeNull();
  });

  it("accepts an adjacent history prefix from a newer cache without advancing live facts", () => {
    const current = {
      offset: 8,
      totalMessages: 10,
      version: { epoch: "runner-epoch-one", sequence: 9 },
      runtime: { turn_state: "working", observed_at: "2026-09-14T12:00:00Z" },
      messages: [{ role: "assistant", text: "eight" }, { role: "assistant", text: "streaming tail" }],
    };
    const incoming = {
      offset: 6,
      totalMessages: 11,
      version: { epoch: "runner-epoch-one", sequence: 10 },
      runtime: { turn_state: "idle", observed_at: "2026-09-14T12:00:01Z" },
      activity: { state: "idle" },
      messages: [{ role: "assistant", text: "six" }, { role: "assistant", text: "seven" }],
    };

    const expanded = reconcileTranscriptWindows(current, incoming);
    expect(expanded).toMatchObject({
      offset: 6,
      totalMessages: 11,
      messages: [{ text: "six" }, { text: "seven" }, { text: "eight" }, { text: "streaming tail" }],
    });
    expect(expanded?.version).toBe(current.version);
    expect(expanded?.runtime).toBe(current.runtime);
    expect(expanded?.messages?.[3]).toBe(current.messages[1]);
    expect(expanded?.activity).toBeUndefined();
    expect(reconcileTranscriptWindows({ ...current, runtime: undefined }, incoming)?.runtime).toBeUndefined();

    // The prefix's sequence must not suppress the subsequent live tail from
    // that same cache version, including its runtime and streaming rewrite.
    const live = reconcileTranscriptWindows(expanded, {
      ...incoming,
      offset: 8,
      messages: [
        { role: "assistant", text: "eight" },
        { role: "assistant", text: "completed tail" },
        { role: "assistant", text: "ten" },
      ],
    });
    expect(live).toMatchObject({
      offset: 6,
      totalMessages: 11,
      messages: [{ text: "six" }, { text: "seven" }, { text: "eight" }, { text: "completed tail" }, { text: "ten" }],
    });
    expect(live?.version).toBe(incoming.version);
    expect(live?.runtime).toBe(incoming.runtime);
  });

  it("still rejects newer partial windows with a gap, smaller total, or overlapping tail", () => {
    const current = {
      offset: 8,
      totalMessages: 10,
      version: { epoch: "runner-epoch-one", sequence: 9 },
      messages: [{ role: "assistant", text: "eight" }, { role: "assistant", text: "tail" }],
    };
    const prefix = {
      offset: 6,
      totalMessages: 10,
      version: { epoch: "runner-epoch-one", sequence: 10 },
      messages: [{ role: "assistant", text: "six" }, { role: "assistant", text: "seven" }],
    };

    expect(reconcileTranscriptWindows(current, { ...prefix, offset: 5 })).toBe(current);
    expect(reconcileTranscriptWindows(current, { ...prefix, totalMessages: 9 })).toBe(current);
    expect(reconcileTranscriptWindows(current, {
      ...prefix,
      messages: [...prefix.messages, { role: "assistant", text: "conflicting eight" }],
    })).toBe(current);
    expect(reconcileTranscriptWindows(current, {
      ...prefix,
      offset: 8,
      messages: [{ role: "assistant", text: "partial tail" }],
    })).toBe(current);

    const reset = { ...prefix, version: { epoch: "runner-epoch-two", sequence: 1 } };
    expect(reconcileTranscriptWindows(current, reset)).toBe(reset);
  });

  it("reconciles history, streaming rewrites, regressions, and source resets", () => {
    const version = (sequence: number, epoch = "runner-epoch-one") => ({ epoch, sequence });
    const current = {
      offset: 8,
      totalMessages: 10,
      version: version(9),
      messages: [{ role: "assistant", text: "eight" }, { role: "assistant", text: "done" }],
    };
    expect(reconcileTranscriptWindows(current, {
      offset: 6,
      totalMessages: 10,
      messages: [{ role: "assistant", text: "six" }, { role: "assistant", text: "seven" }],
    })).toMatchObject({
      offset: 6,
      version: version(9),
      messages: [{ text: "six" }, { text: "seven" }, { text: "eight" }, { text: "done" }],
    });
    expect(reconcileTranscriptWindows(current, {
      offset: 0,
      totalMessages: 2,
      version: version(10),
      messages: [{ role: "assistant", text: "old" }, { role: "assistant", text: "boundary" }],
    })).toBe(current);
    expect(reconcileTranscriptWindows(current, {
      offset: 0,
      totalMessages: 1,
      version: version(1, "runner-epoch-two"),
      messages: [{ role: "assistant", text: "new lineage" }],
    })).toMatchObject({ version: version(1, "runner-epoch-two") });
  });
});

describe("operationOutcomePhase", () => {
  it("is the one reading of a terminal operation status, with unknown its own finished outcome", () => {
    expect(operationOutcomePhase("succeeded")).toBe("succeeded");
    expect(operationOutcomePhase("rejected")).toBe("refused");
    expect(operationOutcomePhase("failed")).toBe("failed");
    expect(operationOutcomePhase("unknown")).toBe("uncertain");
    for (const live of ["submitted", "waiting_approval", "running", "", undefined, "later_status"]) {
      expect(operationOutcomePhase(live)).toBeNull();
    }
  });
});
