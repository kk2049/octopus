/**
 * The wire constants, pinned against the trusted coordinator's own numbers.
 *
 * These are restated in `wire.ts` rather than imported, because this package
 * must not depend on the bot and the bot must not depend on a contract kit. That
 * leaves exactly one way to keep the pair honest: write the numbers down twice
 * and make a change on either side a failing assertion that names the other.
 *
 * The other side, as of 2026-08-07 (editor batch):
 *
 *   packages/bot/src/session-plus/app-service.ts
 *     const RESOURCE_ACTION_PREFIX = "resource.";
 *     const RESOURCE_PARAM_KEY = /^[a-z][a-z0-9_]{0,63}$/;
 *   packages/bot/src/agent-resources/wire-limits.ts
 *     RESOURCE_PARAM_COUNT       = WIRE_PARAM_LIMITS.maxKeys          (imported)
 *     RESOURCE_PARAM_DEFAULT_MAX = WIRE_PARAM_LIMITS.maxValueLength   (imported)
 *     per-parameter bounds       = wireValueLimit(field)              (imported)
 *
 *   packages/web-trust/src/frame-protocol.ts
 *     PORT_MESSAGE_BYTES = 512 * 1024
 *     PORT_STREAM_PULL_ACTION = "resource.stream_pull"  (the fuse's pull credit)
 *
 * The bot now IMPORTS the first three rather than restating them, which is
 * strictly better than this file's original arrangement — the numbers below
 * still guard the shape, and the relationship to the transport's per-message
 * ceiling is asserted here because the ceiling lives in a browser-facing package
 * this one must not depend on.
 *
 *   packages/workspace-files-contract/src/remote.ts
 *     RESOURCE_ACTIONS.streamPull  = "resource.stream_pull"
 *     RESOURCE_ACTIONS.streamClose = "resource.stream_close"
 *     RESOURCE_PARAMS = { binding, ref, handle, seq }
 *
 * A test that READ those files would be stronger, but it would need `node:fs`,
 * and this package's tsconfig is `"types": []` on purpose. The same trade-off is
 * already documented in `packages/workspace-files-contract/CLAUDE.md`: the
 * cross-package boundary test lives on the trusted side, where reading bytes
 * costs nothing.
 */

import { describe, expect, it } from "vitest";

import {
  RESERVED_PARAMS,
  RESOURCE_ACTION_PREFIX,
  STREAM_CLOSE_ACTION,
  STREAM_PULL_ACTION,
  WIRE_PARAM_LIMITS,
  isWireParamKey,
  wireActionOf,
} from "./wire.js";

describe("the numbers the trusted dispatcher enforces", () => {
  it("matches app-service.ts exactly", () => {
    expect(WIRE_PARAM_LIMITS.maxKeys).toBe(8);
    expect(WIRE_PARAM_LIMITS.maxValueLength).toBe(512);
    expect(WIRE_PARAM_LIMITS.keyPattern.source).toBe("^[a-z][a-z0-9_]{0,63}$");
    expect(WIRE_PARAM_LIMITS.keyPattern.flags).toBe("");
    expect(RESOURCE_ACTION_PREFIX).toBe("resource.");
  });

  it("keeps the declared ceiling deliverable inside one 512 KiB message", () => {
    // `PORT_MESSAGE_BYTES` is 512 KiB and is measured on the whole serialised
    // proposal. The ceiling has to leave room for the other seven parameters,
    // for JSON escaping and for the envelope — raising it to the message size
    // would produce declarations that are legal here and undeliverable there.
    const portMessageBytes = 512 * 1024;
    expect(WIRE_PARAM_LIMITS.maxDeclaredValueLength).toBe(384 * 1024);
    expect(WIRE_PARAM_LIMITS.maxDeclaredValueLength).toBeLessThan(portMessageBytes);
    const others = (WIRE_PARAM_LIMITS.maxKeys - 1) * WIRE_PARAM_LIMITS.maxValueLength;
    expect(WIRE_PARAM_LIMITS.maxDeclaredValueLength + others).toBeLessThan(portMessageBytes);
    // One, because two of them could not both fit even at the ceiling.
    expect(WIRE_PARAM_LIMITS.maxOversizedParams).toBe(1);
    expect(WIRE_PARAM_LIMITS.maxDeclaredValueLength * 2).toBeGreaterThan(portMessageBytes);
  });

  it("matches the stream verbs workspace-files/v1 already sends", () => {
    // A contract that spelled these differently would reach a dispatcher that
    // routes by exact action id, and get `unknown_action` for a stream it had
    // just been handed a handle for.
    expect(STREAM_PULL_ACTION).toBe("resource.stream_pull");
    expect(STREAM_CLOSE_ACTION).toBe("resource.stream_close");
    // The legacy frame host's rate fuse admits a credited pull by this exact
    // spelling (`PORT_STREAM_PULL_ACTION`); renaming the verb here without it
    // would put every chunk of a long stream back under the 100-in-10s fuse.
    const portStreamPullAction = "resource.stream_pull";
    expect(STREAM_PULL_ACTION).toBe(portStreamPullAction);
  });

  it("reserves exactly the three parameter names the kit owns", () => {
    expect(RESERVED_PARAMS).toEqual({ binding: "binding", handle: "handle", seq: "seq" });
    // `ref` is deliberately NOT reserved: it is a contract's own parameter,
    // spelled the same way by convention rather than by this kit.
    expect(Object.values(RESERVED_PARAMS)).not.toContain("ref");
  });
});

describe("isWireParamKey", () => {
  it("accepts what the dispatcher accepts, and nothing else", () => {
    expect(isWireParamKey("ref")).toBe(true);
    expect(isWireParamKey("workspace_id")).toBe(true);
    expect(isWireParamKey("a1")).toBe(true);
    expect(isWireParamKey("Ref")).toBe(false);
    expect(isWireParamKey("1a")).toBe(false);
    expect(isWireParamKey("a-b")).toBe(false);
    expect(isWireParamKey("a.b")).toBe(false);
    expect(isWireParamKey("")).toBe(false);
    expect(isWireParamKey("a".repeat(65))).toBe(false);
    expect(isWireParamKey(7)).toBe(false);
  });
});

describe("wireActionOf", () => {
  it("prefixes, and does not double-prefix by accident", () => {
    // Routing by prefix — before manifest normalisation — is what keeps an
    // App's own action surface and the deployment's provider surface from
    // having to be merged into one table both halves must agree about.
    expect(wireActionOf("send_text")).toBe("resource.send_text");
    expect(wireActionOf("resource.send_text")).toBe("resource.resource.send_text");
  });
});
