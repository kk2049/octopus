import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  DESCRIPTOR_FIELD_COVERAGE,
  PACKAGE_LABEL_HEX,
  assetNameProblem,
  computePackageDigest,
  describeRelease,
  packageHostLabel,
  utf8Bytes,
  validateDescriptor,
  verifyPayload,
  type AppReleaseDescriptor,
  type ReleaseSpec,
} from "./descriptor.js";

/**
 * A fixed, complete release. Every test mutates one thing about it, so a
 * failure names the property that broke rather than "something is wrong".
 */
function spec(overrides: Partial<ReleaseSpec> = {}): ReleaseSpec {
  return {
    stableAppId: "demo-app",
    publisher: "octopus:first-party",
    executionProfile: "publisher-js",
    permissionContractDigest: "9f".repeat(16),
    assets: [
      { name: "view/index.html", content: utf8Bytes("<!doctype html><title>demo</title>") },
      { name: "view/main.js", content: utf8Bytes("export const boot = () => {};") },
      { name: "backend/actions.ts", content: utf8Bytes("export function pin() { return 1; }") },
      { name: "shared/schema.json", content: utf8Bytes('{"pin":"boolean"}') },
    ],
    composition: {
      view: ["shared/schema.json", "view/index.html", "view/main.js"],
      backend: ["backend/actions.ts", "shared/schema.json"],
    },
    source: {
      kind: "platform-hosted",
      digest: "sha256:1f".padEnd(20, "0"),
      repository: "platform://octopus/source",
      commit: "0f".repeat(20),
      subdir: "packages/demo-app",
    },
    buildInput: {
      entry: "app.yaml",
      toolchain: { builder: "octopus:app-release-v1", format: "named-assets", lockfile: "pnpm-lock.yaml" },
      lockfileHash: "ab".repeat(32),
    },
    ...overrides,
  };
}

/** Mutate an already-validated descriptor without TypeScript's help. */
function tamper(descriptor: AppReleaseDescriptor, mutate: (row: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(descriptor)) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

describe("canonical descriptor", () => {
  it("is stable: the same release always produces the same digest", () => {
    // A golden value. If the framing changes, every origin this system has ever
    // published changes with it, so that has to be a deliberate act with a
    // failing test attached rather than a refactor nobody noticed.
    expect(describeRelease(spec()).packageDigest).toBe(
      "c33aa5b506d837a3d8648a1557d50d94c174717627639ceede68fa1161e0d399",
    );
  });

  it("does not depend on the order assets or composition names arrive in", () => {
    const forward = describeRelease(spec());
    const shuffled = describeRelease(
      spec({
        assets: [...spec().assets].reverse(),
        composition: {
          view: ["view/main.js", "view/index.html", "shared/schema.json"],
          backend: ["shared/schema.json", "backend/actions.ts"],
        },
      }),
    );
    expect(shuffled.packageDigest).toBe(forward.packageDigest);
    expect(shuffled.assets.map((asset) => asset.name)).toEqual(forward.assets.map((asset) => asset.name));
  });

  it("frames names and lengths, so moving a byte between assets changes the digest", () => {
    // Without length prefixing, "ab" + "c" and "a" + "bc" hash identically.
    const left = describeRelease(
      spec({
        assets: [
          { name: "a.txt", content: utf8Bytes("ab") },
          { name: "b.txt", content: utf8Bytes("c") },
        ],
        composition: { view: ["a.txt", "b.txt"], backend: [] },
      }),
    );
    const right = describeRelease(
      spec({
        assets: [
          { name: "a.txt", content: utf8Bytes("a") },
          { name: "b.txt", content: utf8Bytes("bc") },
        ],
        composition: { view: ["a.txt", "b.txt"], backend: [] },
      }),
    );
    expect(left.packageDigest).not.toBe(right.packageDigest);
  });

  it("gives an empty view group and an empty backend group different digests", () => {
    const noView = describeRelease(spec({ composition: { view: [], backend: ["backend/actions.ts"] } }));
    expect(noView.evidence.viewDigest).not.toBe(noView.evidence.backendDigest);
  });

  it("keeps the host label a pure function of the digest", () => {
    const descriptor = describeRelease(spec());
    expect(packageHostLabel(descriptor.packageDigest)).toBe(
      `app-${descriptor.packageDigest.slice(0, PACKAGE_LABEL_HEX)}`,
    );
    expect(() => packageHostLabel("not-a-digest")).toThrow(/sha256/);
    expect(Object.keys(descriptor)).not.toContain("packageHostLabel");
  });
});

describe("the four identities", () => {
  it("changes the package digest for every field the identity covers", () => {
    const base = describeRelease(spec()).packageDigest;
    const mutations: Array<[string, ReleaseSpec]> = [
      ["stableAppId", spec({ stableAppId: "other-app" })],
      ["publisher", spec({ publisher: "someone-else" })],
      ["executionProfile", spec({ executionProfile: "declarative" })],
      [
        "asset bytes",
        spec({
          assets: [...spec().assets.slice(0, 3), { name: "shared/schema.json", content: utf8Bytes('{"pin":"string"}') }],
        }),
      ],
      [
        "asset names",
        spec({
          assets: [...spec().assets.slice(1), { name: "view/index.htm", content: utf8Bytes("<!doctype html><title>demo</title>") }],
          composition: { view: ["shared/schema.json", "view/index.htm", "view/main.js"], backend: ["backend/actions.ts", "shared/schema.json"] },
        }),
      ],
      [
        "composition",
        spec({ composition: { view: ["view/index.html", "view/main.js"], backend: ["backend/actions.ts", "shared/schema.json"] } }),
      ],
      ["source attestation", spec({ source: { ...spec().source, commit: "1f".repeat(20) } })],
      ["build input", spec({ buildInput: { ...spec().buildInput, lockfileHash: "cd".repeat(32) } })],
    ];
    for (const [label, mutated] of mutations) {
      expect(describeRelease(mutated).packageDigest, label).not.toBe(base);
    }
  });

  it("leaves the package digest alone when only the permission contract changes", () => {
    // The whole point of two axes: a widened ask must not look like a deploy,
    // and a deploy must not look like a permission change.
    const before = describeRelease(spec());
    const after = describeRelease(spec({ permissionContractDigest: "0c".repeat(16) }));
    expect(after.packageDigest).toBe(before.packageDigest);
    expect(after.permissionContractDigest).not.toBe(before.permissionContractDigest);
  });

  it("states digest coverage for every descriptor field", () => {
    // The guard against a future field being added without anyone deciding
    // whether it is part of the release identity.
    const descriptor = describeRelease(spec());
    expect(Object.keys(DESCRIPTOR_FIELD_COVERAGE).sort()).toEqual(Object.keys(descriptor).sort());
    expect(DESCRIPTOR_FIELD_COVERAGE.permissionContractDigest).toBe("separate-axis");
    expect(DESCRIPTOR_FIELD_COVERAGE.evidence).toBe("derived");
  });

  it("does not accept a wrong sub-digest as a different release", () => {
    const descriptor = describeRelease(spec());
    const lying = tamper(descriptor, (row) => {
      (row.evidence as Record<string, unknown>).viewDigest = "ff".repeat(32);
    });
    const verdict = validateDescriptor(lying);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((row) => row.code)).toContain("evidence_mismatch");
  });
});

describe("malformed identity and inventory", () => {
  const cases: Array<[string, (row: Record<string, unknown>) => void, string]> = [
    ["a non-object", () => {}, "not_an_object"],
    ["an unknown top-level field", (row) => { row.extra = 1; }, "unknown_field"],
    ["another schema version", (row) => { row.schemaVersion = 2; }, "schema_version"],
    ["an uppercase app id", (row) => { row.stableAppId = "Demo-App"; }, "identity_charset"],
    ["an app id with a slash", (row) => { row.stableAppId = "demo/app"; }, "identity_charset"],
    ["an unknown execution profile", (row) => { row.executionProfile = "native"; }, "execution_profile"],
    ["a truncated package digest", (row) => { row.packageDigest = "abc"; }, "digest_format"],
    ["a contract digest that is a sentence", (row) => { row.permissionContractDigest = "everything"; }, "digest_format"],
    ["no assets", (row) => { row.assets = []; }, "missing_field"],
    ["an asset with a bad digest", (row) => { (row.assets as Array<Record<string, unknown>>)[0]!.sha256 = "zz"; }, "digest_format"],
    ["an asset with a negative size", (row) => { (row.assets as Array<Record<string, unknown>>)[0]!.bytes = -1; }, "field_type"],
    [
      "an unsorted inventory",
      (row) => { row.assets = [...(row.assets as unknown[])].reverse(); },
      "asset_order",
    ],
    [
      "a duplicated asset name",
      (row) => {
        const assets = row.assets as Array<Record<string, unknown>>;
        assets[1] = { ...assets[0]! };
      },
      "asset_duplicate",
    ],
    [
      "a composition naming an asset that is not there",
      (row) => { (row.composition as Record<string, unknown>).view = ["nope.js"]; },
      "composition_unknown_asset",
    ],
    ["a build input with an unknown field", (row) => { (row.buildInput as Record<string, unknown>).cwd = "/tmp"; }, "unknown_field"],
    ["a lockfile hash that is a path", (row) => { (row.buildInput as Record<string, unknown>).lockfileHash = "/tmp/lock"; }, "digest_format"],
    ["an unknown source kind", (row) => { (row.source as Record<string, unknown>).kind = "signed"; }, "source_kind"],
    ["a package digest that names another release", (row) => { row.packageDigest = "0".repeat(64); }, "package_digest_mismatch"],
  ];

  for (const [label, mutate, code] of cases) {
    it(`rejects ${label}`, () => {
      const descriptor = describeRelease(spec());
      const input = label === "a non-object" ? "not-a-descriptor" : tamper(descriptor, mutate);
      const verdict = validateDescriptor(input);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.issues.map((row) => row.code)).toContain(code);
    });
  }

  it("accepts the release it just described", () => {
    const verdict = validateDescriptor(describeRelease(spec()));
    expect(verdict.ok).toBe(true);
  });

  it("returns a canonical copy rather than the caller's object", () => {
    const descriptor = describeRelease(spec());
    const verdict = validateDescriptor(JSON.parse(JSON.stringify(descriptor)));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(Object.isFrozen(verdict.value)).toBe(true);
    expect(() => {
      (verdict.value as { stableAppId: string }).stableAppId = "hijacked";
    }).toThrow();
  });

  it("ignores a prototype-polluting descriptor", () => {
    const hostile = JSON.parse(`{"__proto__": {"admin": true}, "schemaVersion": 1}`) as unknown;
    const verdict = validateDescriptor(hostile);
    expect(verdict.ok).toBe(false);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe("asset names", () => {
  const rejected = [
    "../escape.js",
    "..",
    ".",
    "/etc/passwd",
    "view/../../etc/passwd",
    "view/./main.js",
    "view//main.js",
    "view/",
    "/view/main.js",
    "view\\main.js",
    "C:/windows/system32",
    "view/main.js\u0000.png",
    "view/main\n.js",
    "-rf",
    "\uFF0Eview/main.js",
  ];

  for (const name of rejected) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(assetNameProblem(name)).not.toBeNull();
    });
  }

  it("accepts ordinary bundle names", () => {
    for (const name of ["index.html", "assets/main-3f2a.js", "fonts/Inter.woff2", "app.yaml", "a.b.c"]) {
      expect(assetNameProblem(name), name).toBeNull();
    }
  });

  it("enforces the length and depth limits", () => {
    expect(assetNameProblem(`${"a".repeat(DEFAULT_LIMITS.maxNameLength + 1)}.js`)).toMatch(/longer than/);
    expect(assetNameProblem(new Array(DEFAULT_LIMITS.maxNameSegments + 2).fill("a").join("/"))).toMatch(/segments/);
  });

  it("refuses a name that is not NFC-normalised", () => {
    // Two byte strings that render identically must not be two assets.
    expect(assetNameProblem("cafe\u0301.js")).toMatch(/NFC/);
  });
});

describe("limits and bounded diagnostics", () => {
  it("refuses more assets than the limit allows", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.js`, content: utf8Bytes(String(i)) }));
    const descriptor = describeRelease(spec({ assets: many, composition: { view: [], backend: [] } }));
    const verdict = validateDescriptor(descriptor, { ...DEFAULT_LIMITS, maxAssets: 5 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues[0]!.code).toBe("asset_limit");
  });

  it("refuses an asset larger than the per-asset limit", () => {
    const descriptor = describeRelease(
      spec({ assets: [{ name: "big.js", content: utf8Bytes("x".repeat(64)) }], composition: { view: [], backend: [] } }),
    );
    const verdict = validateDescriptor(descriptor, { ...DEFAULT_LIMITS, maxAssetBytes: 8 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((row) => row.code)).toContain("asset_size");
  });

  it("refuses a release larger than the total limit", () => {
    const descriptor = describeRelease(
      spec({
        assets: [
          { name: "a.js", content: utf8Bytes("x".repeat(40)) },
          { name: "b.js", content: utf8Bytes("y".repeat(40)) },
        ],
        composition: { view: [], backend: [] },
      }),
    );
    const verdict = validateDescriptor(descriptor, { ...DEFAULT_LIMITS, maxAssetBytes: 64, maxTotalBytes: 64 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((row) => row.code)).toContain("asset_total_size");
  });

  it("caps the diagnostics a hostile candidate can produce", () => {
    const descriptor = describeRelease(spec());
    const flooded = tamper(descriptor, (row) => {
      row.assets = Array.from({ length: 500 }, (_, i) => ({ name: `../${i}`, sha256: "0".repeat(64), bytes: 1 }));
    });
    const verdict = validateDescriptor(flooded, { ...DEFAULT_LIMITS, maxIssues: 8 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.length).toBeLessThanOrEqual(9);
    expect(verdict.issues.at(-1)!.message).toMatch(/further problems/);
  });

  it("neutralises control characters in a diagnostic", () => {
    const descriptor = describeRelease(spec());
    const hostile = tamper(descriptor, (row) => {
      (row.assets as Array<Record<string, unknown>>)[0]!.name = "boot\u001b[2Jstrap.js";
    });
    const verdict = validateDescriptor(hostile);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(JSON.stringify(verdict.issues)).not.toContain("\u001b");
  });
});

describe("payload verification", () => {
  it("accepts exactly the declared bytes", () => {
    const input = spec();
    const descriptor = describeRelease(input);
    const verdict = verifyPayload(descriptor, input.assets);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.map((row) => row.name)).toEqual(descriptor.assets.map((row) => row.name));
  });

  it("rejects a payload whose bytes do not hash to the inventory", () => {
    const input = spec();
    const descriptor = describeRelease(input);
    const swapped = input.assets.map((asset) =>
      asset.name === "view/main.js" ? { name: asset.name, content: utf8Bytes("export const boot = steal;") } : asset,
    );
    const verdict = verifyPayload(descriptor, swapped);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues[0]!.code).toBe("asset_digest");
    expect(verdict.issues[0]!.at).toBe("view/main.js");
  });

  it("rejects a payload that is missing or carries extra assets", () => {
    const input = spec();
    const descriptor = describeRelease(input);
    const missing = verifyPayload(descriptor, input.assets.slice(1));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0]!.code).toBe("asset_missing");

    const extra = verifyPayload(descriptor, [...input.assets, { name: "stow.js", content: utf8Bytes("x") }]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.issues[0]!.code).toBe("asset_unexpected");
  });
});

describe("the source of this package", () => {
  it("contains no literal control bytes", () => {
    // A NUL in a source file makes git classify it as binary: no diff, no
    // review and no blame on the module that decides which code a hostname
    // names. `identity.ts` learned this the hard way; so did this file.
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
      const bytes = readFileSync(path.join(dir, name));
      const bad = [...bytes].some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f);
      expect(bad, name).toBe(false);
    }
  });
});
