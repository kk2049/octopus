import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionContract } from "@claude-bot/engine";
import { PermissionService } from "../permissions/service.js";
import { Store } from "../store/store.js";
import { SESSION_PLUS_SUBJECT_ENTRY } from "./catalog.js";
import {
  SESSION_PLUS_APP_ID,
  SESSION_PLUS_AUTO_ALLOW,
  SESSION_PLUS_OPERATIONS,
  SESSION_PLUS_PUBLISHER,
  sessionPlusEngineContract,
  sessionPlusPermissionContractDigest,
} from "./contract.js";
import { IntentGrantResolver } from "./intent-resolver.js";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

describe("IntentGrantResolver", () => {
  let dir: string;
  let store: Store;
  let permissions: PermissionService;
  let resolver: IntentGrantResolver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-plus-resolver-"));
    store = new Store(join(dir, "state.db"));
    permissions = new PermissionService({
      store,
      now: () => NOW,
      bootstrapSessionHub: false,
      subjects: [SESSION_PLUS_SUBJECT_ENTRY],
    });
    resolver = new IntentGrantResolver(permissions, () => NOW);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function grant(
    owner: string,
    operations: readonly string[] = SESSION_PLUS_OPERATIONS,
    autoAllow: readonly string[] = SESSION_PLUS_AUTO_ALLOW,
    expiresAt?: string,
  ): void {
    permissions.grant({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner,
      operations,
      autoAllow,
      source: "config",
      createdBy: "system:config",
      contractDigest: sessionPlusPermissionContractDigest(),
      publisher: SESSION_PLUS_PUBLISHER,
      expiresAt,
    });
  }

  it("binds the same app declaration independently to each authenticated owner", () => {
    grant("alice", ["list_recent_sessions", "read_session"], ["read_session"]);
    const contract = sessionPlusEngineContract();
    expect(resolver.effective(contract, "alice")).toEqual({
      operations: ["list_recent_sessions", "read_session"],
      autoAllow: ["read_session"],
      delivery: [],
    });
    expect(resolver.effective(contract, "bob")).toEqual({ operations: [], autoAllow: [], delivery: [] });
    expect(resolver.effective(contract)).toEqual({ operations: [], autoAllow: [], delivery: [] });
  });

  it("keeps the previously granted intersection when a contract widens", () => {
    grant("alice", ["list_recent_sessions", "read_session"], ["list_recent_sessions", "read_session"]);
    const widened = sessionPlusEngineContract();
    expect(resolver.effective(widened, "alice").operations).toEqual([
      "list_recent_sessions",
      "read_session",
    ]);
    expect(resolver.check(widened, "alice")).toMatchObject({
      ok: false,
      needsAuthorization: true,
      missingOperations: ["append_session", "list_session_workspaces", "search_sessions", "start_session"],
    });

    const narrowed: PermissionContract = {
      ...widened,
      operations: ["read_session"],
      autoAllow: ["read_session"],
    };
    expect(resolver.check(narrowed, "alice")).toMatchObject({ ok: true, needsAuthorization: false });
  });

  it("fails closed on revoke, expiry, publisher change, and a different app id", () => {
    grant("alice", SESSION_PLUS_OPERATIONS, SESSION_PLUS_AUTO_ALLOW, new Date(NOW + 1_000).toISOString());
    const contract = sessionPlusEngineContract();
    expect(resolver.check(contract, "alice").ok).toBe(true);

    const wrongPublisher = { ...contract, publisher: "somebody-else" };
    expect(resolver.effective(wrongPublisher, "alice").operations).toEqual([]);
    expect(resolver.check(wrongPublisher, "alice").reason).toContain("different publisher");

    const otherApp = { ...contract, app: "other-app" };
    expect(resolver.effective(otherApp, "alice").operations).toEqual([]);

    expect(permissions.revoke({
      subjectType: "app",
      subjectId: SESSION_PLUS_APP_ID,
      owner: "alice",
      by: "alice",
    })).toBe(true);
    expect(resolver.effective(contract, "alice").operations).toEqual([]);

    grant("alice", SESSION_PLUS_OPERATIONS, SESSION_PLUS_AUTO_ALLOW, new Date(NOW - 1).toISOString());
    expect(resolver.effective(contract, "alice").operations).toEqual([]);
  });
});
