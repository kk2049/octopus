/**
 * The wire vocabulary itself, driven directly.
 *
 * This file is the leaf both halves import; a rename, a stray field, or a
 * silent bump of `SESSION_PLUS_PROTOCOL` is the kind of change that would let
 * two release cycles disagree without either side noticing. The assertions
 * below are deliberately about identity of the CONSTANTS rather than about
 * behaviour — behaviour lives in `frame-host.test.ts` (Host) and
 * `client.test.ts` (View), and both of them consume the constants that are
 * fixed here.
 */

import { describe, expect, it } from "vitest";
import {
  APPEARANCE_CONTRACT,
  APPEARANCE_THEME_ID_MAX_LEN,
  APPEARANCE_THEME_ID_PATTERN,
  BROWSER_DRAFT_ACTIVE_KEYS_MAX,
  BROWSER_DRAFT_KEY_MAX,
  BROWSER_DRAFT_TEXT_MAX,
  MSG,
  PORT_MESSAGE_BYTES,
  PORT_WINDOW_MESSAGES,
  PORT_WINDOW_MS,
  SESSION_PLUS_PROTOCOL,
  VIEW_HELLO,
  VIEW_RECONNECT,
  VIEW_RECOVERY_BYTES,
  WAKE_DEBOUNCE_MS,
  WAKE_WINDOW_MESSAGES,
  type AppearanceSpec,
  readAgentViewPerformanceWindow,
} from "./frame-protocol.js";

describe("the wire vocabulary", () => {
  it("keeps SESSION_PLUS_PROTOCOL at 'session-plus/2' — additive kinds must not bump it", () => {
    // Bumping this string is not a change of file, it is a coordinated
    // release: every already-shipped View bundle refuses a mismatched Host.
    // A test says so out loud so a well-meaning `+= "/3"` fails here first.
    expect(SESSION_PLUS_PROTOCOL).toBe("session-plus/2");
  });

  it("keeps VIEW_HELLO as a payload-free constant string", () => {
    expect(VIEW_HELLO).toBe("session-plus:view-hello");
    // No JSON, no fields: the announcement carries no data, and the parent
    // authenticates the sender by comparing `event.source` to the frame it
    // created.
    expect(JSON.stringify(VIEW_HELLO)).not.toContain("{");
  });

  it("keeps the reload recovery prompt payload-free", () => {
    expect(VIEW_RECONNECT).toBe("session-plus:view-reconnect");
    expect(JSON.stringify(VIEW_RECONNECT)).not.toContain("{");
  });

  it("names each MSG kind exactly once and does not remove any existing kind", () => {
    // Two halves in different bundles import this table by NAME. A silent
    // rename would mean an ignored kind on the receiver — a whole class of
    // 'nothing happens' bugs the compiler cannot see.
    expect(MSG).toEqual({
      port: "port",
      boot: "boot",
      view: "view",
      ready: "ready",
      height: "height",
      propose: "propose",
      result: "result",
      op: "op",
      appearance: "appearance",
      recovery: "recovery",
      wake: "wake",
      debug: "debug",
      debugResult: "debug_result",
      debugEvent: "debug_event",
      draftRead: "draft_read",
      draftWrite: "draft_write",
      draftUpdate: "draft_update",
      performance: "performance",
    });
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });

  it("bounds the browser-local draft bridge below the port payload fuse", () => {
    expect(BROWSER_DRAFT_KEY_MAX).toBe(512);
    expect(BROWSER_DRAFT_TEXT_MAX).toBe(64 * 1024);
    expect(BROWSER_DRAFT_TEXT_MAX).toBeLessThan(PORT_MESSAGE_BYTES);
    expect(BROWSER_DRAFT_ACTIVE_KEYS_MAX).toBe(32);
  });

  it("bounds one browser recovery checkpoint below the port payload fuse", () => {
    expect(VIEW_RECOVERY_BYTES).toBe(48 * 1024);
    expect(VIEW_RECOVERY_BYTES).toBeLessThan(PORT_MESSAGE_BYTES);
  });

  it("copies only the closed content-free View performance vocabulary", () => {
    const report = {
      version: 1,
      windowMs: 60_000,
      inputEventCount: 12,
      inputFrameCount: 10,
      inputFrameTotalMs: 140.5,
      inputFrameMaxMs: 44.1,
      inputFrameOver50Count: 0,
      projectionCommitCount: 22,
      projectionCommitTotalMs: 81.2,
      projectionCommitMaxMs: 8.4,
      projectionFrameCount: 20,
      projectionFrameTotalMs: 201.5,
      projectionFrameMaxMs: 18.2,
      longTaskCount: 1,
      longTaskTotalMs: 72.1,
      longTaskMaxMs: 72.1,
      timerLagCount: 0,
      timerLagMaxMs: 0,
      domNodes: 8_400,
      transcript: "must not cross",
    };
    const expected: Record<string, unknown> = { ...report };
    delete expected.transcript;
    expect(readAgentViewPerformanceWindow(report)).toEqual(expected);
    expect(readAgentViewPerformanceWindow({ ...report, inputEventCount: -1 })).toBeNull();
    expect(readAgentViewPerformanceWindow({ ...report, inputFrameMaxMs: Number.NaN })).toBeNull();
  });

  it("keeps the wake budget an order of magnitude below the port fuse", () => {
    // Every wake invites one `propose`, and `propose` is counted by a fuse
    // that does not refuse but CLOSES the channel. The exact numbers may move;
    // this inequality may not: a wake budget near the fuse budget would let a
    // chatty server spend the View's whole window and leave nothing for the
    // person's own clicks riding the same channel (ADR 0006 §5).
    expect(WAKE_WINDOW_MESSAGES * 10).toBeLessThanOrEqual(PORT_WINDOW_MESSAGES);
    // Debounce must cover a real burst of typing (the editor batches at
    // ~600 ms), and a zero or negative debounce is a wake per keystroke.
    expect(WAKE_DEBOUNCE_MS).toBeGreaterThanOrEqual(600);
    expect(WAKE_DEBOUNCE_MS).toBeLessThan(PORT_WINDOW_MS);
  });

  it("declares appearance/v1 as the only recognised appearance contract", () => {
    expect(APPEARANCE_CONTRACT).toBe("appearance/v1");
  });

  it("bounds `theme` by length and character class rather than by enumeration", () => {
    // The wire deliberately does NOT enumerate the outer shell's THEMES set.
    // Adding a shell theme (a new brand, an experimental palette) must not
    // require a coordinated web-trust bump and a rebuild of every shipped
    // Agent View bundle. So the wire says only "kebab-case, bounded", and
    // the two consumers decide policy:
    //   - Host constructs values from its closed THEMES set (upstream check).
    //   - View maintains its own SUPPORTED_VIEW_THEMES and folds unknown to
    //     classic (best-effort defence).
    expect(APPEARANCE_THEME_ID_MAX_LEN).toBe(64);
    expect(APPEARANCE_THEME_ID_PATTERN.test("classic")).toBe(true);
    expect(APPEARANCE_THEME_ID_PATTERN.test("aurora")).toBe(true);
    expect(APPEARANCE_THEME_ID_PATTERN.test("ink")).toBe(true);
    // A future outer-shell-only theme that a shipped View predates is valid
    // on the wire; the View is what will fold it to classic.
    expect(APPEARANCE_THEME_ID_PATTERN.test("sunset-2027")).toBe(true);
    // Hostile inputs the reader must never let through as an attribute value.
    expect(APPEARANCE_THEME_ID_PATTERN.test("aurora'; drop--")).toBe(false);
    expect(APPEARANCE_THEME_ID_PATTERN.test("Aurora")).toBe(false); // uppercase
    expect(APPEARANCE_THEME_ID_PATTERN.test("")).toBe(false);
    expect(APPEARANCE_THEME_ID_PATTERN.test("1classic")).toBe(false); // digit start
    expect(APPEARANCE_THEME_ID_PATTERN.test("x".repeat(65))).toBe(false); // too long
    expect(APPEARANCE_THEME_ID_PATTERN.test("x".repeat(64))).toBe(true);
  });

  it("compiles a minimal appearance spec against its declared shape", () => {
    // The point is that the shape has one field to name today and no others.
    // Additive drift ('colorScheme?', 'reducedMotion?') would let a
    // caller invent behaviour the outer shell does not have; the type sits
    // here to make such drift a compile error. `theme` is `string`, not a
    // closed union — that policy is the View's, not the wire's.
    const spec: AppearanceSpec = { contract: APPEARANCE_CONTRACT, theme: "aurora" };
    expect(spec.contract).toBe("appearance/v1");
    const forward: AppearanceSpec = { contract: APPEARANCE_CONTRACT, theme: "sunset-2027" };
    expect(forward.theme).toBe("sunset-2027");
  });
});
