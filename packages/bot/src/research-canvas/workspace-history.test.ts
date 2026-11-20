import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFileSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHistory } from "./workspace-history.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  // Leave reads unrecorded unless a case needs to intercept them. A suite-wide
  // spy retains each 1 MiB buffer across the 10,000-file scan and restore.
  return { ...fs };
});
describe("workspace checkpoints", () => {
  it("restores overwritten, deleted, binary and untracked files and keeps a before-image", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-"));
    try {
      mkdirSync(join(root, "plugins")); writeFileSync(join(root, "plugins", "code.mjs"), "v1");
      writeFileSync(join(root, "data.bin"), Buffer.from([0, 1, 255]));
      const history = new WorkspaceHistory(root), checkpoint = history.checkpoint();
      writeFileSync(join(root, "plugins", "code.mjs"), "v2"); rmSync(join(root, "data.bin"));
      writeFileSync(join(root, "new.txt"), "new");
      const restored = history.restore(checkpoint.id);
      expect(readFileSync(join(root, "plugins", "code.mjs"), "utf8")).toBe("v1");
      expect([...readFileSync(join(root, "data.bin"))]).toEqual([0, 1, 255]);
      expect(restored.removed).toBe(1);
      history.restore(restored.before);
      expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("new");
      expect(readFileSync(join(root, "plugins", "code.mjs"), "utf8")).toBe("v2");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("checkpoints and restores a 300 MiB workspace with files past 64 MiB and more than 10,000 files", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-large-"));
    try {
      const big = (name: string, mebibytes: number, fill: number) => {
        const fd = openSync(join(root, name), "w"), block = Buffer.alloc(1024 * 1024, fill), hash = createHash("sha256");
        try { for (let i = 0; i < mebibytes; i++) { writeSync(fd, block); hash.update(block); } } finally { closeSync(fd); }
        return hash.digest("hex");
      };
      const digests = [big("a.bin", 100, 1), big("b.bin", 100, 2), big("c.bin", 100, 3)];
      mkdirSync(join(root, "many"));
      for (let i = 0; i < 10_050; i++) writeFileSync(join(root, "many", `f${i}.txt`), String(i % 7));
      // The scans happen well after the files were written, so their versions are not racy.
      let now = Date.now() + 10_000;
      const history = new WorkspaceHistory(root, 120, () => now), first = history.checkpoint();
      expect(Object.keys(first.files)).toHaveLength(10_053);
      expect(first.unsaved).toEqual([]);
      expect(first.readBytes).toBeGreaterThanOrEqual(300 * 1024 * 1024);
      expect(["a.bin", "b.bin", "c.bin"].map(name => first.files[name].digest)).toEqual(digests);
      // Unchanged file versions reuse their digest without being read again.
      now += 60_000;
      const second = history.checkpoint();
      expect(second.readBytes).toBe(0);
      expect(second.files["a.bin"]).toEqual(first.files["a.bin"]);
      writeFileSync(join(root, "a.bin"), "small now"); rmSync(join(root, "many", "f1.txt"));
      now = Date.now() + 10_000;
      const third = history.checkpoint();
      expect(third.readBytes).toBe(Buffer.byteLength("small now"));
      const restored = history.restore(first.id);
      expect(restored).toMatchObject({ restored: 10_053, removed: 0 });
      expect(createHash("sha256").update(readFileSync(join(root, "a.bin"))).digest("hex")).toBe(digests[0]);
      expect(readFileSync(join(root, "many", "f1.txt"), "utf8")).toBe("1");
      expect(readdirSync(join(root, ".research-history", "blobs")).filter(name => name.startsWith(".incoming"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
  it("names a file that changes while it is read instead of failing the checkpoint", async () => {
    const { readSync: actualReadSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "workspace-history-racy-"));
    const read = vi.spyOn(fs, "readSync");
    try {
      writeFileSync(join(root, "log.txt"), "line\n");
      writeFileSync(join(root, "stable.txt"), "kept");
      const history = new WorkspaceHistory(root);
      // The first read is of log.txt (sorted first); a writer appends while it is read.
      read.mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
        appendFileSync(join(root, "log.txt"), "appended\n");
        return actualReadSync(...args);
      });
      const checkpoint = history.checkpoint();
      expect(checkpoint.unsaved).toEqual([{ path: "log.txt", bytes: 5, reason: "changed" }]);
      expect(Object.keys(checkpoint.files)).toEqual(["stable.txt"]);
      // A whole restore leaves a file the checkpoint could not save in place.
      writeFileSync(join(root, "stable.txt"), "edited");
      expect(history.restore(checkpoint.id)).toMatchObject({ restored: 1, removed: 0 });
      expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("line\nappended\n");
      expect(readFileSync(join(root, "stable.txt"), "utf8")).toBe("kept");
    } finally {
      read.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("flushes new content once when many files share a blob", async () => {
    const { fsyncSync: actualSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "workspace-history-dedup-"));
    let fileFlushes = 0;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isFile()) fileFlushes++;
      actualSync(fd);
    });
    try {
      for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${i}`), "same bytes");
      const history = new WorkspaceHistory(root), saved = history.checkpoint();
      expect(Object.keys(saved.files)).toHaveLength(20);
      expect(readdirSync(join(root, ".research-history", "blobs"))).toEqual([saved.files.f0.digest]);
      // One durable blob plus the manifest; discarded duplicates need no flush.
      expect(fileFlushes).toBe(2);
      expect(readFileSync(join(root, ".research-history", "blobs", saved.files.f0.digest), "utf8")).toBe("same bytes");
    } finally { sync.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps matching file versions in place while restoring changed bytes, permissions and missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-unchanged-"));
    try {
      for (const name of ["unchanged", "edited", "mode", "missing"]) writeFileSync(join(root, name), "saved");
      fs.chmodSync(join(root, "mode"), 0o600);
      const history = new WorkspaceHistory(root, 120, () => Date.now() + 10_000), saved = history.checkpoint();
      const unchanged = fs.lstatSync(join(root, "unchanged"), { bigint: true });
      writeFileSync(join(root, "edited"), "other");
      fs.chmodSync(join(root, "mode"), 0o700);
      rmSync(join(root, "missing"));
      const restored = history.restore(saved.id);
      expect(restored.restored).toBe(4);
      expect(fs.lstatSync(join(root, "unchanged"), { bigint: true })).toMatchObject({ ino: unchanged.ino, mtimeNs: unchanged.mtimeNs });
      for (const name of ["unchanged", "edited", "mode", "missing"]) expect(readFileSync(join(root, name), "utf8")).toBe("saved");
      expect(fs.lstatSync(join(root, "mode")).mode & 0o777).toBe(0o600);
      history.restore(restored.before);
      expect(readFileSync(join(root, "edited"), "utf8")).toBe("other");
      expect(fs.lstatSync(join(root, "mode")).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(join(root, "missing"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rechecks matching versions after the before-image and still restores a changed or deleted target", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-restore-race-"));
    try {
      writeFileSync(join(root, "edited"), "saved"); writeFileSync(join(root, "deleted"), "saved");
      const history = new WorkspaceHistory(root, 120, () => Date.now() + 10_000), saved = history.checkpoint(), checkpoint = history.checkpoint.bind(history);
      vi.spyOn(history, "checkpoint").mockImplementationOnce(pinned => {
        const before = checkpoint(pinned);
        writeFileSync(join(root, "edited"), "other"); rmSync(join(root, "deleted"));
        return before;
      });
      expect(history.restore(saved.id).restored).toBe(2);
      expect(readFileSync(join(root, "edited"), "utf8")).toBe("saved");
      expect(readFileSync(join(root, "deleted"), "utf8")).toBe("saved");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not trust a recent matching version when a coarse timestamp hides a concurrent write", async () => {
    const { lstatSync: actualStat } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "workspace-history-coarse-")), target = join(root, "file");
    const stat = vi.spyOn(fs, "lstatSync");
    try {
      writeFileSync(target, "saved");
      const history = new WorkspaceHistory(root), saved = history.checkpoint(), checkpoint = history.checkpoint.bind(history);
      vi.spyOn(history, "checkpoint").mockImplementationOnce(pinned => {
        const before = checkpoint(pinned), coarse = actualStat(target, { bigint: true });
        writeFileSync(target, "other");
        stat.mockImplementation((...args: Parameters<typeof fs.lstatSync>) =>
          args[0] === target && typeof args[1] === "object" && args[1]?.bigint ? coarse : actualStat(...args));
        return before;
      });
      history.restore(saved.id);
      expect(readFileSync(target, "utf8")).toBe("saved");
    } finally { stat.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
  it("still breaks hard links and strips special permission bits from matching files", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-modes-"));
    try {
      writeFileSync(join(root, "file"), "saved"); fs.linkSync(join(root, "file"), join(root, "link"));
      writeFileSync(join(root, "special"), "saved"); fs.chmodSync(join(root, "special"), 0o1600);
      const history = new WorkspaceHistory(root, 120, () => Date.now() + 10_000), saved = history.checkpoint();
      history.restore(saved.id);
      writeFileSync(join(root, "link"), "changed");
      expect(readFileSync(join(root, "file"), "utf8")).toBe("saved");
      expect(fs.lstatSync(join(root, "special")).mode & 0o7777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("verifies even unchanged blobs before overwriting or removing any workspace file", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-corrupt-"));
    try {
      writeFileSync(join(root, "a-edited"), "first"); writeFileSync(join(root, "z-unchanged"), "last");
      const history = new WorkspaceHistory(root), saved = history.checkpoint();
      writeFileSync(join(root, "a-edited"), "other"); writeFileSync(join(root, "new"), "keep");
      writeFileSync(join(root, ".research-history", "blobs", saved.files["z-unchanged"].digest), "bad");
      expect(() => history.restore(saved.id)).toThrow("verification");
      expect(readFileSync(join(root, "a-edited"), "utf8")).toBe("other");
      expect(readFileSync(join(root, "z-unchanged"), "utf8")).toBe("last");
      expect(readFileSync(join(root, "new"), "utf8")).toBe("keep");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses path traversal and symlink access, and bounds retention", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-history-"));
    try {
      const history = new WorkspaceHistory(root, 2);
      writeFileSync(join(root, "file"), "1"); symlinkSync("/etc/passwd", join(root, "outside"));
      const first = history.checkpoint();
      expect(first.skipped).toContain("outside");
      expect(() => history.read("../file")).toThrow("inside");
      expect(() => history.read("outside")).toThrow("Symlinks");
      writeFileSync(join(root, "file"), "2"); history.checkpoint();
      writeFileSync(join(root, "file"), "3"); history.checkpoint();
      expect(history.list()).toHaveLength(2);
      expect(() => history.restore(first.id)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
