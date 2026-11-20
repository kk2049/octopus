import { describe, expect, it } from "vitest";
import { inputNotSent, markInputHandoff, notSentRefusalCode, withInputAttempt } from "./input-handoff.js";

describe("session input handoff evidence", () => {
  it("reports whether the attempt reached a transport, across awaits, without leaking between attempts", async () => {
    const before = await withInputAttempt(async () => {
      await Promise.resolve();
      return "validated";
    });
    expect(before).toEqual({ value: "validated", handedOff: false });
    const after = await withInputAttempt(async () => {
      await Promise.resolve();
      markInputHandoff();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return "sent";
    });
    expect(after).toEqual({ value: "sent", handedOff: true });
    // Outside an attempt the mark is inert.
    expect(() => markInputHandoff()).not.toThrow();
  });

  it("retains only refusals proven to precede sending", () => {
    expect(notSentRefusalCode(Object.assign(new Error("busy"), { code: "session_active" }))).toBe("session_active");
    expect(notSentRefusalCode(Object.assign(new Error("again"), { code: "duplicate_terminal_send" }))).toBe("duplicate_terminal_send");
    expect(notSentRefusalCode(inputNotSent(new Error("changed")))).toBe("input_not_sent");
    expect(notSentRefusalCode(Object.assign(new Error("setup"), { code: "transport_unavailable", safeFallback: true }))).toBe("transport_unavailable");
    expect(notSentRefusalCode(Object.assign(new Error("refused"), { inputRejected: true }))).toBe("input_not_sent");
    // Possible delivery, unclassified failures and explicit uncertainty stay unknown.
    expect(notSentRefusalCode(Object.assign(new Error("lost"), { safeFallback: false }))).toBeUndefined();
    expect(notSentRefusalCode(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBeUndefined();
    expect(notSentRefusalCode(inputNotSent(Object.assign(new Error("?"), { code: "unknown" })))).toBeUndefined();
    expect(notSentRefusalCode(new Error("plain"))).toBeUndefined();
    expect(notSentRefusalCode("text")).toBeUndefined();
  });

  it("requires per-attempt not-sent evidence for desktop protocol errors", () => {
    const protocolError = () => Object.assign(new Error("unsupported stream version 999"), { code: "codex_gui_protocol_unsupported" });
    expect(notSentRefusalCode(inputNotSent(protocolError()))).toBe("codex_gui_protocol_unsupported");
    // The code alone cannot classify a state update received after dispatch.
    expect(notSentRefusalCode(protocolError())).toBeUndefined();
  });
});
