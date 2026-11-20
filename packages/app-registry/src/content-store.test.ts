import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileReleaseContentStore, assertSafeRoot } from "./content-store.js";
import { utf8Bytes } from "./descriptor.js";
import type { StoredAsset, StoredAssetIdentity } from "./ports.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "app-registry-content-"));
  roots.push(root);
  return path.join(root, "artifacts");
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function asset(name: string, text: string): StoredAsset {
  const content = utf8Bytes(text);
  return {
    name,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    content,
  };
}

function inventory(assets: readonly StoredAsset[]): StoredAssetIdentity[] {
  return assets.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }));
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

describe("safe roots", () => {
  it("refuses a root that is not an already-resolved absolute path", () => {
    expect(() => assertSafeRoot("relative/path")).toThrow(/absolute/);
    expect(() => assertSafeRoot("~/artifacts")).toThrow(/absolute/);
    expect(() => assertSafeRoot("/data/~backup/artifacts")).toThrow(/unexpanded/);
    expect(() => assertSafeRoot("/srv/$DATA_DIR/artifacts")).toThrow(/unexpanded/);
    expect(() => assertSafeRoot("/srv/octopus/../artifacts")).toThrow(/normalised/);
  });

  it("refuses the filesystem root and the home directory itself", () => {
    expect(() => assertSafeRoot("/")).toThrow(/filesystem root/);
    expect(() => assertSafeRoot(homedir())).toThrow(/home directory/);
  });

  it("creates its tree 0700", () => {
    const root = tempRoot();
    new FileReleaseContentStore(root);
    for (const dir of ["", "blobs", "releases", "tmp"]) {
      expect(statSync(path.join(root, dir)).mode & 0o777, dir || ".").toBe(0o700);
    }
  });

  it("refuses a symlink at the root or an intermediate blob directory", () => {
    const linkedRoot = tempRoot();
    const outside = path.join(path.dirname(linkedRoot), "outside");
    mkdirSync(outside);
    symlinkSync(outside, linkedRoot, "dir");
    expect(() => new FileReleaseContentStore(linkedRoot)).toThrow(/not a real directory/);

    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const one = asset("main.js", "boot");
    const shard = path.join(root, "blobs", one.sha256.slice(0, 2));
    const shardTarget = path.join(path.dirname(root), "outside-shard");
    mkdirSync(shardTarget);
    symlinkSync(shardTarget, shard, "dir");
    expect(() => store.put(DIGEST_A, [one])).toThrow(/not a real directory/);
  });
});

describe("storing an artifact", () => {
  it("addresses blobs by digest, so an asset name never becomes a path", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    // A name the descriptor layer would have rejected. Even if it reaches the
    // store, there is no code path that turns it into a filesystem path.
    const evil = asset("../../../../tmp/pwned", "payload");
    store.put(DIGEST_A, [evil]);

    expect(existsSync(path.join(path.dirname(root), "pwned"))).toBe(false);
    expect(existsSync("/tmp/pwned")).toBe(false);
    expect(existsSync(path.join(root, "blobs", evil.sha256.slice(0, 2), evil.sha256))).toBe(true);
    expect(store.read(DIGEST_A, "../../../../tmp/pwned", inventory([evil]))).toBeNull();
  });

  it("is idempotent: the same content stores once", () => {
    const store = new FileReleaseContentStore(tempRoot());
    const one = asset("main.js", "shared");
    store.put(DIGEST_A, [one]);
    store.put(DIGEST_B, [one]);
    expect(store.verify(DIGEST_A, inventory([one])).ok).toBe(true);
    expect(store.verify(DIGEST_B, inventory([one])).ok).toBe(true);
    expect(store.listStored()).toEqual([DIGEST_A, DIGEST_B].sort());
  });

  it("repairs an existing same-size blob whose bytes no longer match its digest", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const one = asset("main.js", "boot");
    store.put(DIGEST_A, [one]);
    const blob = path.join(root, "blobs", one.sha256.slice(0, 2), one.sha256);
    writeFileSync(blob, "boo7");
    expect(store.verify(DIGEST_A, inventory([one]))).toMatchObject({ ok: false, code: "content_corrupt" });

    store.put(DIGEST_A, [one]);
    expect(store.verify(DIGEST_A, inventory([one])).ok).toBe(true);
    expect(Buffer.from(store.read(DIGEST_A, "main.js", inventory([one]))!).toString()).toBe("boot");
  });

  it("refuses to store bytes under a digest that is not theirs", () => {
    const store = new FileReleaseContentStore(tempRoot());
    const lying = { ...asset("main.js", "real"), sha256: "0".repeat(64) };
    expect(() => store.put(DIGEST_A, [lying])).toThrow(/does not match its digest/);
    expect(store.has(DIGEST_A)).toBe(false);
  });

  it("leaves nothing readable when the manifest never lands", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root, {
      fault: (point) => {
        if (point === "before_manifest_rename") throw new Error("power loss");
      },
    });
    const one = asset("main.js", "half-written");
    expect(() => store.put(DIGEST_A, [one])).toThrow(/power loss/);
    // The blob survived; the release did not. That is the safe direction: an
    // unreferenced artifact wastes disk, an incomplete one would be served.
    expect(store.has(DIGEST_A)).toBe(false);
    expect(store.checkManifest(DIGEST_A, inventory([one]))).toMatchObject({ ok: false, code: "content_missing" });
    expect(store.listStored()).toEqual([]);
    expect(readdirSync(path.join(root, "tmp"))).toEqual([]);
  });

  it("survives a crash after the manifest lands", () => {
    const root = tempRoot();
    let thrown = false;
    const store = new FileReleaseContentStore(root, {
      fault: (point) => {
        if (point === "after_manifest_rename" && !thrown) {
          thrown = true;
          throw new Error("power loss");
        }
      },
    });
    const one = asset("main.js", "complete");
    expect(() => store.put(DIGEST_A, [one])).toThrow(/power loss/);
    const reopened = new FileReleaseContentStore(root);
    expect(reopened.verify(DIGEST_A, inventory([one])).ok).toBe(true);
    expect(Buffer.from(reopened.read(DIGEST_A, "main.js", inventory([one]))!).toString()).toBe("complete");
  });
});

describe("reading an artifact", () => {
  it("refuses a manifest that redirects a descriptor name to another valid blob", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const expected = asset("main.js", "expected");
    const substituted = asset("main.js", "substitute");
    store.put(DIGEST_A, [expected]);
    store.put(DIGEST_B, [substituted]);
    writeFileSync(
      path.join(root, "releases", `${DIGEST_A}.json`),
      JSON.stringify({ format: 1, packageDigest: DIGEST_A, assets: inventory([substituted]) }),
    );

    expect(store.checkManifest(DIGEST_A, inventory([expected]))).toMatchObject({
      ok: false,
      code: "content_corrupt",
    });
    expect(store.read(DIGEST_A, "main.js", inventory([expected]))).toBeNull();
  });

  it("only answers to an exact name", () => {
    const store = new FileReleaseContentStore(tempRoot());
    const one = asset("assets/main.js", "boot");
    store.put(DIGEST_A, [one]);
    expect(store.read(DIGEST_A, "assets/main.js", inventory([one]))).not.toBeNull();
    for (const name of ["assets/main.js/", "assets", "./assets/main.js", "main.js", "assets/main.js\u0000"]) {
      expect(store.read(DIGEST_A, name, inventory([one])), name).toBeNull();
    }
  });

  it("refuses a blob that has been replaced by a symlink", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const one = asset("main.js", "boot");
    store.put(DIGEST_A, [one]);

    const secret = path.join(path.dirname(root), "secret.txt");
    writeFileSync(secret, "PRIVATE KEY");
    const blob = path.join(root, "blobs", one.sha256.slice(0, 2), one.sha256);
    unlinkSync(blob);
    symlinkSync(secret, blob);

    expect(store.read(DIGEST_A, "main.js", inventory([one]))).toBeNull();
    expect(store.checkManifest(DIGEST_A, inventory([one]))).toMatchObject({ ok: false, code: "content_corrupt" });
    expect(store.verify(DIGEST_A, inventory([one])).ok).toBe(false);
  });

  it("refuses a blob whose bytes were edited under it", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const one = asset("main.js", "boot");
    store.put(DIGEST_A, [one]);
    writeFileSync(path.join(root, "blobs", one.sha256.slice(0, 2), one.sha256), "bootX");

    // Same length, different bytes: the cheap check cannot see it, the exact
    // one can, and a read never hands back content that fails its own digest.
    expect(store.checkManifest(DIGEST_A, inventory([one])).ok).toBe(false);
    writeFileSync(path.join(root, "blobs", one.sha256.slice(0, 2), one.sha256), "boo7");
    expect(store.checkManifest(DIGEST_A, inventory([one])).ok).toBe(true);
    expect(store.verify(DIGEST_A, inventory([one]))).toMatchObject({ ok: false, code: "content_corrupt" });
    expect(store.read(DIGEST_A, "main.js", inventory([one]))).toBeNull();
  });

  it("reports a missing blob rather than a partial release", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const one = asset("main.js", "boot");
    const two = asset("second.js", "more");
    const assets = [one, two];
    store.put(DIGEST_A, assets);
    unlinkSync(path.join(root, "blobs", one.sha256.slice(0, 2), one.sha256));

    expect(store.checkManifest(DIGEST_A, inventory(assets))).toMatchObject({ ok: false, code: "content_missing" });
    expect(store.read(DIGEST_A, "main.js", inventory(assets))).toBeNull();
    expect(store.read(DIGEST_A, "second.js", inventory(assets))).not.toBeNull();
  });

  it("treats a damaged manifest as an absent artifact", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    const one = asset("main.js", "boot");
    store.put(DIGEST_A, [one]);
    writeFileSync(path.join(root, "releases", `${DIGEST_A}.json`), "{ not json");
    expect(store.has(DIGEST_A)).toBe(false);
    expect(store.checkManifest(DIGEST_A, inventory([one]))).toMatchObject({ ok: false, code: "content_missing" });

    writeFileSync(
      path.join(root, "releases", `${DIGEST_A}.json`),
      JSON.stringify({ format: 1, packageDigest: DIGEST_B, assets: [] }),
    );
    expect(store.has(DIGEST_A)).toBe(false);
  });

  it("refuses an oversized manifest before allocating its declared size", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    writeFileSync(path.join(root, "releases", `${DIGEST_A}.json`), " ".repeat(2 * 1024 * 1024));
    expect(store.has(DIGEST_A)).toBe(false);
  });

  it("ignores files in releases/ that are not release manifests", () => {
    const root = tempRoot();
    const store = new FileReleaseContentStore(root);
    store.put(DIGEST_A, [asset("main.js", "boot")]);
    writeFileSync(path.join(root, "releases", "notes.txt"), "hello");
    writeFileSync(path.join(root, "releases", "../escape.json"), "{}");
    expect(store.listStored()).toEqual([DIGEST_A]);
  });
});
