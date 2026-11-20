/**
 * The trusted-side decoder, checked DIFFERENTIALLY against the kit's.
 *
 * `decodeCrdtParams` exists to drop exactly one rule — the View wire's flat
 * 512-character clamp — and to keep every other rule the kit applies. A second
 * decoder that quietly diverged anywhere else would be the "two implementations
 * that drift" failure this repository has documented evidence about, so the
 * agreement is asserted rather than reviewed: for every value that fits in 512
 * characters, both decoders must accept the same things and produce the same
 * issue codes.
 */

import { describe, expect, it } from "vitest";
import { decodeWireParams } from "@claude-bot/typed-port-kit";

import { CRDT_DOC_DECLARATION, CRDT_DOC_LIMITS } from "./contract.js";
import { crdtActionOf, decodeCrdtParams } from "./decode.js";

const DOC = "cd_0123456789abcdef";

/** A base64 string of exactly `chars` characters. */
function b64(chars: number): string {
  return "A".repeat(chars);
}

function issueCodes(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return (result.issues ?? []).map((issue) => issue.code).sort();
}

const CASES: readonly { name: string; action: "open_doc" | "apply_update" | "read_updates"; params: Record<string, unknown> }[] = [
  { name: "a valid open", action: "open_doc", params: { doc: DOC } },
  { name: "a valid small update", action: "apply_update", params: { doc: DOC, update: b64(64) } },
  { name: "a valid small state vector", action: "read_updates", params: { doc: DOC, since: b64(8) } },
  { name: "a missing parameter", action: "apply_update", params: { doc: DOC } },
  { name: "an unknown parameter", action: "open_doc", params: { doc: DOC, origin: "me" } },
  { name: "a non-string parameter", action: "open_doc", params: { doc: 7 } },
  { name: "a ref that breaks its pattern", action: "open_doc", params: { doc: "两个字" } },
  { name: "an update that breaks base64", action: "apply_update", params: { doc: DOC, update: "not base64!!" } },
  { name: "nothing at all", action: "open_doc", params: {} },
];

describe("decodeCrdtParams agrees with the kit below 512 characters", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}`, () => {
      const action = crdtActionOf(testCase.action)!;
      const mine = decodeCrdtParams(action, testCase.params);
      const kit = decodeWireParams(action, testCase.params);
      expect(mine.ok).toBe(kit.ok);
      expect(issueCodes(mine)).toEqual(issueCodes(kit));
      if (mine.ok && kit.ok) expect(mine.value).toEqual(kit.value);
    });
  }
});

describe("the one FORMER divergence (healed by the per-action wire bounds, 2026-08-07)", () => {
  it("agrees with the kit decoder now that declared bounds travel", () => {
    // HISTORY: before P6b the kit clamped every parameter at 512 characters,
    // so this contract kept its own decoder for values the wire could never
    // carry — a deliberate, documented divergence. The kit now honours the
    // action's declared bound, so both decoders accept the same update and
    // the divergence is an agreement pinned in both directions.
    const action = crdtActionOf("apply_update")!;
    const update = b64(2048);
    const kit = decodeWireParams(action, { doc: DOC, update });
    expect(kit.ok).toBe(true);

    const mine = decodeCrdtParams(action, { doc: DOC, update });
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.value.update).toBe(update);
  });

  it("still refuses an update past the CONTRACT's own bound", () => {
    // Dropping the wire's clamp does not mean dropping every bound: an
    // unbounded parameter is a proposal nobody can measure.
    const action = crdtActionOf("apply_update")!;
    const mine = decodeCrdtParams(action, {
      doc: DOC,
      update: b64(CRDT_DOC_LIMITS.maxUpdateEncodedLength + 4),
    });
    expect(mine.ok).toBe(false);
    expect(issueCodes(mine)).toEqual(["limit"]);
  });

  it("applies the same bound to a state vector", () => {
    const action = crdtActionOf("read_updates")!;
    expect(decodeCrdtParams(action, { doc: DOC, since: b64(CRDT_DOC_LIMITS.maxStateVectorEncodedLength) }).ok).toBe(true);
    expect(decodeCrdtParams(action, { doc: DOC, since: b64(CRDT_DOC_LIMITS.maxStateVectorEncodedLength + 4) }).ok).toBe(
      false,
    );
  });
});

describe("action lookup", () => {
  it("returns null for a verb this contract does not have", () => {
    expect(crdtActionOf("delete_doc")).toBeNull();
    expect(crdtActionOf("resource.apply_update")).toBeNull();
    expect(crdtActionOf("apply_update")?.action).toBe("apply_update");
  });

  it("keeps every declared action reachable by its id", () => {
    for (const id of CRDT_DOC_DECLARATION.actionIds) expect(crdtActionOf(id)).not.toBeNull();
  });
});
