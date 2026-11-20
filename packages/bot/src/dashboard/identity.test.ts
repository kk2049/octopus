/**
 * The two pure decisions behind ticket #15's permission model: what a
 * credential may do, and where an unauthenticated panel is allowed to listen.
 */
import { describe, it, expect } from "vitest";
import { resolveCapabilities, resolveBindHost, isLoopbackAddress, ADMIN_KEY_IDENTITY } from "./server.js";

describe("resolveCapabilities", () => {
  it("gives a plain account nothing until something is granted", () => {
    expect(resolveCapabilities({ username: "bob" })).toEqual({
      username: "bob",
      admin: false,
      dev: false,
      deploy: false,
      contribute: false,
    });
  });

  it("makes the configured admin an admin without erasing their account", () => {
    // The point of the whole refactor: admin is a capability layered on an
    // identity, so lht can read across users AND still write as lht.
    const id = resolveCapabilities({ username: "lht", admins: ["lht"] });
    expect(id).toEqual({ username: "lht", admin: true, dev: true, deploy: true, contribute: true });
  });

  it("grants dev alone without implying deploy", () => {
    expect(resolveCapabilities({ username: "bob", granted: ["dev"] })).toMatchObject({
      dev: true,
      deploy: false,
      admin: false,
    });
  });

  it("treats deploy as implying dev — you cannot ship what you cannot see", () => {
    expect(resolveCapabilities({ username: "bob", granted: ["deploy"] })).toMatchObject({
      dev: true,
      deploy: true,
    });
  });

  it("honours the legacy deployers list but drops its empty=everyone rule", () => {
    expect(resolveCapabilities({ username: "bob", deployers: ["bob"] })).toMatchObject({ deploy: true });
    // Empty list used to mean "anyone may fast-forward the base branch".
    expect(resolveCapabilities({ username: "bob", deployers: [] })).toMatchObject({ deploy: false });
    expect(resolveCapabilities({ username: "bob" })).toMatchObject({ deploy: false });
  });

  it("does not let a grant name make someone admin", () => {
    expect(resolveCapabilities({ username: "bob", granted: ["admin", "root"] })).toMatchObject({
      admin: false,
      dev: false,
      deploy: false,
    });
  });

  it("shared key is admin with no account to sign as", () => {
    expect(ADMIN_KEY_IDENTITY.username).toBeUndefined();
    expect(ADMIN_KEY_IDENTITY).toMatchObject({ admin: true, dev: true, deploy: true });
  });
});

describe("resolveBindHost", () => {
  it("leaves an authenticated panel where the operator put it", () => {
    expect(resolveBindHost(undefined, "sekrit")).toEqual({ host: "0.0.0.0" });
    expect(resolveBindHost("0.0.0.0", "sekrit")).toEqual({ host: "0.0.0.0" });
    expect(resolveBindHost("127.0.0.1", "sekrit")).toEqual({ host: "127.0.0.1" });
  });

  it("refuses to publish an unauthenticated panel, whatever the config says", () => {
    // No auth_token means every request is admin; the only safe answer is to
    // be unreachable from off-box. A same-host TLS proxy still works.
    const forced = resolveBindHost("0.0.0.0", undefined);
    expect(forced.host).toBe("127.0.0.1");
    expect(forced.forced).toContain("0.0.0.0");

    expect(resolveBindHost("10.0.0.5", "").host).toBe("127.0.0.1");
    expect(resolveBindHost(undefined, undefined).host).toBe("127.0.0.1");
  });

  it("says nothing when loopback was already the explicit intent", () => {
    expect(resolveBindHost("127.0.0.1", undefined)).toEqual({ host: "127.0.0.1" });
    expect(resolveBindHost("::1", undefined)).toEqual({ host: "::1" });
  });
});

describe("isLoopbackAddress", () => {
  it("accepts loopback in both stacks, including the dual-stack form", () => {
    // Node reports an IPv4 loopback peer on a dual-stack listener as
    // ::ffff:127.0.0.1 — reading that as remote would break the devpipe
    // tool callbacks on a perfectly normal host.
    for (const a of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1", "localhost"]) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
  });
  it("rejects everything else, including addresses that merely look local", () => {
    for (const a of ["10.0.0.5", "192.168.1.7", "::ffff:10.0.0.5", "1.127.0.0.1", "", "127001"]) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
  });
});
