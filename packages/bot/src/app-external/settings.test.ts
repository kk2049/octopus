/**
 * The external-host allowlist, which is the whole of "who may hold a binding".
 *
 * Two properties are being pinned, and the second is the one that has teeth:
 * absent configuration serves nobody, and a configuration an operator got
 * WRONG stops the process instead of quietly serving a narrower — or wider —
 * set than they wrote.
 */

import { describe, expect, it } from "vitest";
import { EXTERNAL_LAUNCH_FRAGMENT_KEY } from "./contract.js";
import { externalAppHostSettings, externalLaunchUrl } from "./settings.js";

const HOST = { id: "dsh-local", label: "本机 DSH", origin: "http://127.0.0.1:9931" };

describe("external_app_hosts is off unless it is written", () => {
  it("answers null for absent, disabled and explicitly-empty configuration", () => {
    expect(externalAppHostSettings(undefined)).toBeNull();
    expect(externalAppHostSettings({})).toBeNull();
    expect(externalAppHostSettings({ enabled: false, hosts: [HOST] })).toBeNull();
  });

  it("refuses `enabled` with nothing to enable, rather than serving an empty allowlist", () => {
    expect(() => externalAppHostSettings({ enabled: true })).toThrow(/at least one/);
    expect(() => externalAppHostSettings({ enabled: true, hosts: [] })).toThrow(/at least one/);
  });
});

describe("an entry is one exact loopback origin", () => {
  it("accepts the three loopback spellings, with their ports", () => {
    const settings = externalAppHostSettings({
      enabled: true,
      hosts: [
        HOST,
        { id: "dsh-v6", origin: "http://[::1]:9931" },
        { id: "dsh-name", origin: "https://localhost:9932" },
      ],
    })!;
    expect([...settings.origins]).toEqual([
      "http://127.0.0.1:9931",
      "http://[::1]:9931",
      "https://localhost:9932",
    ]);
    expect(settings.hosts.get("dsh-local")?.label).toBe("本机 DSH");
    // A label defaults to the id rather than to nothing: the page shows it.
    expect(settings.hosts.get("dsh-v6")?.label).toBe("dsh-v6");
    expect(settings.hosts.get("dsh-local")?.launchPath).toBe("/octopus/app-launch");
  });

  it("refuses every remote origin, encrypted or not", () => {
    for (const origin of [
      "https://dsh.example.com",
      "https://u-1001.dsh.16-58-204-8.sslip.io",
      "http://10.0.0.5:9931",
      // Loopback to the kernel, not what an operator meant to write.
      "http://127.0.0.2:9931",
    ]) {
      expect(() => externalAppHostSettings({ enabled: true, hosts: [{ id: "h", origin }] }), origin)
        .toThrow(/loopback/);
    }
  });

  it("refuses wildcards, paths and every near miss of an exact origin", () => {
    const refused: Array<[string, RegExp]> = [
      ["http://*.localhost:9931", /wildcard/],
      ["*", /wildcard/],
      ["", /exact origin/],
      // Trailing slash, path, query, fragment: an origin has none of them.
      ["http://127.0.0.1:9931/", /path|exactly/],
      ["http://127.0.0.1:9931/launch", /path/],
      ["http://127.0.0.1:9931?a=1", /path/],
      ["http://127.0.0.1:9931#f", /path/],
      ["http://user:pw@127.0.0.1:9931", /path|userinfo/],
      // The default port spelled out: the URL parser drops it, so the written
      // form and the compared form would differ.
      ["http://localhost:80", /exactly/],
      ["https://localhost:443", /exactly/],
      ["HTTP://127.0.0.1:9931", /exactly/],
      // An integer-encoded loopback address: refused for not being written as
      // its own canonical form, before the loopback question is even asked.
      ["http://2130706433:9931", /exactly/],
      ["ws://127.0.0.1:9931", /http or https/],
      ["file:///etc", /http or https/],
      ["127.0.0.1:9931", /not a URL|http or https/],
      ["localhost", /not a URL/],
    ];
    for (const [origin, message] of refused) {
      expect(() => externalAppHostSettings({ enabled: true, hosts: [{ id: "h", origin }] }), origin)
        .toThrow(message);
    }
  });

  it("refuses a repeated id or a repeated origin", () => {
    expect(() => externalAppHostSettings({ enabled: true, hosts: [HOST, { ...HOST, label: "second" }] }))
      .toThrow(/repeats the id/);
    expect(() => externalAppHostSettings({ enabled: true, hosts: [HOST, { ...HOST, id: "other" }] }))
      .toThrow(/repeats the origin/);
  });

  it("refuses an id or a launch path that could smuggle something else", () => {
    expect(() => externalAppHostSettings({ enabled: true, hosts: [{ id: "Bad Id", origin: HOST.origin }] }))
      .toThrow(/id/);
    for (const launch_path of ["octopus/launch", "/launch#hash", "\\\\evil", "/" + "x".repeat(300)]) {
      expect(() => externalAppHostSettings({ enabled: true, hosts: [{ ...HOST, launch_path }] }), launch_path)
        .toThrow(/launch_path/);
    }
  });
});

describe("the bounded numbers have documented, secret-free defaults", () => {
  it("defaults to a two-minute handoff and a twelve-hour binding", () => {
    const settings = externalAppHostSettings({ enabled: true, hosts: [HOST] })!;
    expect(settings.launchTtlSeconds).toBe(120);
    expect(settings.capabilityTtlSeconds).toBe(43_200);
    expect(settings.maxBindingsPerUser).toBe(8);
  });

  it("refuses values outside the bounds instead of clamping them", () => {
    const with_ = (extra: Record<string, number>) =>
      () => externalAppHostSettings({ enabled: true, hosts: [HOST], ...extra });
    expect(with_({ launch_ttl_seconds: 5 })).toThrow(/launch_ttl_seconds/);
    expect(with_({ launch_ttl_seconds: 5_000 })).toThrow(/launch_ttl_seconds/);
    expect(with_({ capability_ttl_seconds: 60 })).toThrow(/capability_ttl_seconds/);
    expect(with_({ max_bindings_per_user: 0 })).toThrow(/max_bindings_per_user/);
    expect(with_({ max_bindings_per_user: 1.5 })).toThrow(/max_bindings_per_user/);
  });
});

describe("the launch URL keeps its secret out of everything a server logs", () => {
  it("puts the token in the fragment, never the path or the query", () => {
    const settings = externalAppHostSettings({ enabled: true, hosts: [HOST] })!;
    const url = externalLaunchUrl(settings.hosts.get("dsh-local")!, EXTERNAL_LAUNCH_FRAGMENT_KEY, "xlg_secret-value");
    expect(url).toBe(`http://127.0.0.1:9931/octopus/app-launch#${EXTERNAL_LAUNCH_FRAGMENT_KEY}=xlg_secret-value`);
    const parsed = new URL(url);
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/octopus/app-launch");
    // What a server on the other end would actually receive.
    expect(`${parsed.pathname}${parsed.search}`).not.toContain("xlg_");
  });
});
