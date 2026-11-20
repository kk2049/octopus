/**
 * `app-permissions/v1`, and the refusals that keep it a statement rather than a
 * lever.
 *
 * This document exists so a release can SAY which permission contract it asks
 * for. Everything interesting here is therefore about the two ways that could
 * stop being true: a document that says more than one thing (extra fields, a
 * second contract, a free-text rationale a reader would trust), and a document
 * whose bytes could be written two ways for one meaning — which would let two
 * artifacts with different digests make identical claims.
 */

import { describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS_SCHEMA,
  encodeAppPermissions,
  parseAppPermissions,
  readAppPermissions,
  type AppPermissions,
} from "./permissions-doc.js";

const DOC: AppPermissions = { schema: APP_PERMISSIONS_SCHEMA, contract: "sessions-workspace-write/v1" };

describe("reading a permission declaration", () => {
  it("accepts the minimal document, and nothing else is required", () => {
    const read = readAppPermissions(DOC);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({
      schema: "app-permissions/v1",
      contract: "sessions-workspace-write/v1",
    });
  });

  it("refuses a field this build does not understand", () => {
    // The category the whole validate layer exists for: an unknown key is either
    // a newer schema (which must not be optimistically interpreted) or a typo
    // that silently disabled something. A release asset gets the loud answer.
    const read = readAppPermissions({ ...DOC, operations: ["read_workspace_text"] });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.issues.map((issue) => issue.code)).toContain("unknown_field");
  });

  it("refuses another schema, including a plausible neighbour", () => {
    for (const schema of ["app-permissions/v2", "agent-resource-bindings/v1", ""]) {
      expect(readAppPermissions({ ...DOC, schema }).ok).toBe(false);
    }
  });

  it("refuses a missing, non-string or ill-formed contract id", () => {
    expect(readAppPermissions({ schema: APP_PERMISSIONS_SCHEMA }).ok).toBe(false);
    expect(readAppPermissions({ ...DOC, contract: 1 }).ok).toBe(false);
    // Not a name: a path, an absolute path, a URL, and an unversioned id. None
    // of these is ever resolved by anything — which is exactly why the grammar
    // has to refuse them here rather than downstream.
    for (const contract of [
      "../sessions/v1",
      "/etc/passwd",
      "https://example.com/contract",
      "sessions-workspace-write",
      "Sessions/v1",
    ]) {
      expect(readAppPermissions({ ...DOC, contract }).ok, contract).toBe(false);
    }
  });

  it("refuses anything that is not a JSON object", () => {
    for (const value of [null, "app-permissions/v1", 5, [DOC]]) {
      expect(readAppPermissions(value).ok).toBe(false);
    }
    expect(parseAppPermissions("{ not json").ok).toBe(false);
  });
});

describe("canonical encoding", () => {
  it("round-trips byte for byte", () => {
    const encoded = encodeAppPermissions(DOC);
    const read = parseAppPermissions(encoded);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(encodeAppPermissions(read.value)).toBe(encoded);
  });

  it("is two-space indented and newline terminated, like every sibling document", () => {
    expect(encodeAppPermissions(DOC)).toBe(
      '{\n  "schema": "app-permissions/v1",\n  "contract": "sessions-workspace-write/v1"\n}\n',
    );
  });

  it("does not accept a second byte representation of one declaration", () => {
    // The property a release adapter depends on: it compares the received bytes
    // against `encode(parse(bytes))`, so "one plan, one digest-protected
    // representation" is an equality rather than a claim about a formatter.
    const canonical = encodeAppPermissions(DOC);
    for (const variant of [
      JSON.stringify(DOC),
      `${canonical} `,
      `${canonical}\n`,
      JSON.stringify({ contract: DOC.contract, schema: DOC.schema }, null, 2) + "\n",
    ]) {
      const read = parseAppPermissions(variant);
      // Each of these still PARSES — they are the same declaration — but none of
      // them is the canonical byte string, which is what the adapter refuses.
      expect(read.ok, variant).toBe(true);
      if (!read.ok) continue;
      expect(encodeAppPermissions(read.value), variant).not.toBe(variant);
    }
  });
});
