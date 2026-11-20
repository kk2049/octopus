/**
 * The server-state defaults, tested as the decisions they are.
 *
 * Ordinary GETs are server-local reads, so a transient failure heals itself
 * and a returning reader sees fresh data — within bounds that keep a billed
 * uplink from re-downloading large answers on every window switch. The four
 * capability-bearing session reads must never inherit that, which is why the
 * last block proves no page queries them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { focusManager, onlineManager, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import {
  createQueryClient,
  isReplaySafe,
  pollInterval,
  QUERY_RETRIES,
  QUERY_STALE_MS,
  REPLAY_SAFE,
  retryTransient,
  transientFailure,
} from "./query.js";

describe("query defaults", () => {
  const defaults = createQueryClient().getDefaultOptions();

  it("retries only failures the server did not decide, at most twice", () => {
    expect(defaults.queries?.retry).toBe(retryTransient);
    expect(QUERY_RETRIES).toBe(2);
    expect(transientFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(transientFailure(new ApiError("HTTP 502 · 响应为空", 502, "empty_body"))).toBe(true);
    expect(transientFailure(new ApiError("internal", 500))).toBe(true);
    for (const status of [0, 400, 401, 403, 404, 409, 422, 429]) {
      expect(transientFailure(new ApiError("decided", status)), String(status)).toBe(false);
    }
    expect(transientFailure(new Error("a bug in a query function"))).toBe(false);
    expect(retryTransient(0, new TypeError("offline"))).toBe(true);
    expect(retryTransient(1, new TypeError("offline"))).toBe(true);
    expect(retryTransient(2, new TypeError("offline"))).toBe(false);
  });

  it("never retries a mutation — append/approve/deploy are not idempotent", () => {
    expect(defaults.mutations?.retry).toBe(false);
  });

  it("refetches stale data on focus and reconnect, never on mount, and adds no polling", () => {
    expect(defaults.queries?.refetchOnWindowFocus).toBe(true);
    expect(defaults.queries?.refetchOnReconnect).toBe(true);
    expect(defaults.queries?.refetchOnMount).toBe(false);
    expect(defaults.queries?.staleTime).toBe(QUERY_STALE_MS);
    expect(QUERY_STALE_MS).toBeGreaterThanOrEqual(30_000);
    expect(defaults.queries?.refetchInterval).toBeUndefined();
  });
});

describe("focus and reconnect with the shipped client", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  it("re-reads only data older than the stale window", async () => {
    vi.useFakeTimers();
    const client = createQueryClient();
    client.mount();
    let reads = 0;
    const observer = new QueryObserver(client, { queryKey: ["probe"], queryFn: async () => ++reads });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(reads).toBe(1));
      // Switching windows inside the stale window downloads nothing.
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(reads).toBe(1);

      await vi.advanceTimersByTimeAsync(QUERY_STALE_MS);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.waitFor(() => expect(reads).toBe(2));
      onlineManager.setOnline(false);
      await vi.advanceTimersByTimeAsync(QUERY_STALE_MS + 1);
      onlineManager.setOnline(true);
      await vi.waitFor(() => expect(reads).toBe(3));
    } finally {
      unsubscribe();
      client.unmount();
    }
  });

  it("heals a read that hit a restart, then stops after two retries", async () => {
    vi.useFakeTimers();
    const client = createQueryClient();
    let attempts = 0;
    const healed = client.fetchQuery({ queryKey: ["restart"], queryFn: async () => {
      attempts += 1;
      if (attempts < 3) throw new ApiError("HTTP 502", 502);
      return "ok";
    } });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(healed).resolves.toBe("ok");
    expect(attempts).toBe(3);

    let refused = 0;
    const denied = client.fetchQuery({ queryKey: ["refused"], queryFn: async () => {
      refused += 1;
      throw new ApiError("forbidden", 403);
    } });
    await expect(denied).rejects.toThrow("forbidden");
    expect(refused).toBe(1);
  });
});

describe("the replay-safe allow-list", () => {
  it("contains no endpoint that reaches a Runner, a transcript or a submission", () => {
    const forbidden = [
      "/api/session",
      "/api/sessions",
      "/api/sessions/search",
      "/api/sessions/live",
      "/api/sessions/append",
      "/api/sessions/operations",
      "/api/session-plus/act",
      "/api/permissions/grant",
      "/api/feishu/oauth/start",
    ];
    for (const path of forbidden) {
      expect(REPLAY_SAFE as readonly string[]).not.toContain(path);
    }
  });

  it("recognises a family by prefix, not by exact string", () => {
    expect(isReplaySafe("/api/tickets/12/session?limit=200")).toBe(true);
    expect(isReplaySafe("/api/deploy/active")).toBe(true);
    expect(isReplaySafe("/api/dev/system-status")).toBe(true);
  });

  it("does NOT admit a capability-bearing path that merely looks similar", () => {
    // `/api/sessions` is not `/api/session`, and neither is on the list.
    expect(isReplaySafe("/api/sessions?username=alice")).toBe(false);
    expect(isReplaySafe("/api/session?id=abc")).toBe(false);
    expect(isReplaySafe("/api/sessions/live?id=abc")).toBe(false);
  });
});

describe("pollInterval()", () => {
  it("refuses to poll anything off the list, whatever number is passed", () => {
    expect(pollInterval("/api/sessions?username=alice", 5000)).toBe(false);
    expect(pollInterval("/api/session?id=abc", 1000)).toBe(false);
  });

  it("returns the interval for an endpoint that is a plain server-local read", () => {
    expect(pollInterval("/api/tickets", 10_000)).toBe(10_000);
    expect(pollInterval("/api/capabilities/pending", 5000)).toBe(5000);
    expect(pollInterval("/api/dev/system-status", 10_000)).toBe(10_000);
    expect(pollInterval("/api/feishu/oauth/status?username=alice", 2_000)).toBe(2_000);
  });
});

describe("capability-bearing reads", () => {
  // A refused read on these becomes an approval card, so retry/focus/reconnect
  // defaults would ask a person to approve it again. Today no page reads them;
  // one that starts to must turn replay off for that query (and update this).
  const CAPABILITY_READS = ["/api/session", "/api/sessions", "/api/sessions/search", "/api/sessions/live"];
  const names = (text: string) => CAPABILITY_READS.includes(text.split("?")[0]!);

  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = join(directory, entry.name);
      return entry.isDirectory() ? sources(file)
        : /\.tsx?$/.test(file) && !file.includes(".test.") ? [file] : [];
    });
  }

  /** String literals and template heads only: comments may name the routes. */
  function readers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && names(node.text)) {
        found.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it("are not read by any Dashboard page", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const found = sources(root).flatMap((file) => readers(file).map((text) => `${relative(root, file)}: ${text}`));
    expect(found).toEqual([]);
    expect(names("/api/sessions/live?id=x")).toBe(true);
    expect(names("/api/session")).toBe(true);
    expect(names("/api/sessions/operations")).toBe(false);
    expect(names("/api/session-plus/act")).toBe(false);
  });
});
