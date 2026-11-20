import { describe, expect, it } from "vitest";
import { composeViewDocument, composeViewDocumentFrom, splitViewTemplate, VIEW_APP_HTML } from "./view-app.js";

describe("the Agent View document", () => {
  it("uses keyboard-aware mobile viewport semantics without disabling zoom", () => {
    expect(VIEW_APP_HTML).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">',
    );
    expect(VIEW_APP_HTML).not.toMatch(/user-scalable=no|maximum-scale/i);
  });

  it("builds a deterministic document with CSP hashes instead of a nonce", () => {
    const first = composeViewDocument("body{color:red}", "globalThis.ready=true");
    const second = composeViewDocument("body{color:red}", "globalThis.ready=true");
    expect(first).toEqual(second);
    expect(first.immutable).toBe(true);
    expect(first.policy.kind).toBe("hash");
    expect(first.body).toContain("<style>body{color:red}</style>");
    expect(first.body).toContain("<script>globalThis.ready=true</script>");
    expect(first.body).not.toContain("nonce=");
  });

  it("continues composing an installed legacy nonce template without caching it", () => {
    const legacy = '<style nonce="%NONCE%">%CSS%</style><script nonce="%NONCE%">%JS%</script>';
    expect(splitViewTemplate(legacy).kind).toBe("nonce");
    const document = composeViewDocumentFrom(legacy, "legacy_nonce_123", ".x{}", "run()");
    expect(document).toMatchObject({ immutable: false, policy: { kind: "nonce", nonce: "legacy_nonce_123" } });
    expect(document.body).toContain('<script nonce="legacy_nonce_123">run()</script>');
  });
});
