/**
 * The chat file-link resolver: display-path arithmetic in one projection's
 * vocabulary, then an ORDERED set of starting points on the files plane, then
 * a listed walk that tries them until one listing really contains the path.
 *
 * Two families of property live here. The ordering ones say the key-exact join
 * still wins and the guesses are bounded and deterministic (ticket #61 widened
 * the resolver so a workspace whose key never reached this side is openable —
 * not so that anything is opened by name). The walk ones say a guess costs one
 * "no such entry" and nothing else: a REFUSAL is the answer and stops
 * everything, because retrying past `approval_required` is how one click
 * becomes a stack of approval cards.
 */

import { describe, expect, it } from "vitest";
import {
  chatFileLinkPath,
  decodeLinkPath,
  isFileishLink,
  pathSegments,
  planWalk,
  relativeLinkSegments,
  resolveLinkPath,
  walkToFile,
  type ListDirectory,
  type ResolveEntry,
  type WalkCandidate,
} from "./file-link.js";

describe("chatFileLinkPath", () => {
  const origin = "https://app-9b226dbdbee53a624188.apps.example.org";
  const path = "/home/ubuntu/lht/auto-research/agentcc-case-walkthrough/r06-20260907/L2-WALKTHROUGH.md";

  it("recovers the reported absolute path from a URL expanded against the View", () => {
    expect(chatFileLinkPath(`${origin}${path}`, `${origin}/view`)).toBe(path);
    expect(chatFileLinkPath(`${origin}${path}`, "https://app-0123456789abcdef0123.apps.example.org/view"))
      .toBe(path);
    expect(chatFileLinkPath(`${origin}/home/u/%E6%8A%A5%E5%91%8A.md#L2`, `${origin}/view`))
      .toBe("/home/u/报告.md");
    expect(chatFileLinkPath(path, `${origin}/view`)).toBe(path);
    expect(chatFileLinkPath("src/new.md", `${origin}/view`)).toBe("src/new.md");
  });

  it("does not reinterpret external, credential-bearing or non-HTTP URLs as local files", () => {
    for (const href of [
      `https://example.com${path}`, `//example.com${path}`,
      `${origin}.example.com${path}`, `http://${new URL(origin).host}${path}`,
      `https://app-0123456789abcdef0123.apps.example.com${path}`,
      `https://app-not-a-digest.apps.example.org${path}`, `${origin}:444${path}`,
      `https://someone@${new URL(origin).host}${path}`, "file:///etc/passwd",
      "javascript:alert(1)", "#section", "?search=doc", "https://[invalid",
    ]) expect(chatFileLinkPath(href, `${origin}/view`)).toBeNull();
  });
});

describe("decodeLinkPath", () => {
  it("undoes the renderer's percent-encoding so segments match listing labels", () => {
    expect(decodeLinkPath("/home/u/oh-my-pi-%E6%8A%80%E6%9C%AF%E6%8A%A5%E5%91%8A.md"))
      .toBe("/home/u/oh-my-pi-\u6280\u672f\u62a5\u544a.md");
  });

  it("is total: an unencoded or malformed href comes back verbatim", () => {
    expect(decodeLinkPath("~/lht/a.ts")).toBe("~/lht/a.ts");
    expect(decodeLinkPath("~/lht/100%.md")).toBe("~/lht/100%.md");
    expect(decodeLinkPath("~/lht/%zz.md")).toBe("~/lht/%zz.md");
  });
});

describe("isFileishLink", () => {
  it("keeps schemes, anchors and queries for the browser; paths for us", () => {
    expect(isFileishLink("https://example.com/a.ts")).toBe(false);
    expect(isFileishLink("mailto:x@y.z")).toBe(false);
    expect(isFileishLink("#section")).toBe(false);
    expect(isFileishLink("?q=1")).toBe(false);
    expect(isFileishLink("")).toBe(false);
    expect(isFileishLink("src/foo.ts")).toBe(true);
    expect(isFileishLink("/home/u/proj/foo.ts")).toBe(true);
    expect(isFileishLink("~/proj/foo.ts")).toBe(true);
  });
});

describe("pathSegments / resolveLinkPath", () => {
  it("normalises `.`,`..` and doubled separators inside the root", () => {
    expect(pathSegments("~/proj//src/./a.ts")).toEqual(["~", "proj", "src", "a.ts"]);
    expect(pathSegments("~/proj/src/../lib/b.ts")).toEqual(["~", "proj", "lib", "b.ts"]);
    expect(pathSegments("/var/log/x")).toEqual(["", "var", "log", "x"]);
  });

  it("refuses to climb above the root, and refuses elided displays", () => {
    expect(pathSegments("~/../etc/passwd")).toBeNull();
    expect(pathSegments("~/…/proj")).toBeNull();
    expect(pathSegments("relative/only")).toBeNull();
  });

  it("resolves a relative link against the session's cwd display", () => {
    expect(resolveLinkPath("~/proj", "src/foo.ts")).toEqual(["~", "proj", "src", "foo.ts"]);
    expect(resolveLinkPath("~/proj", "./src/foo.ts")).toEqual(["~", "proj", "src", "foo.ts"]);
    expect(resolveLinkPath("~/proj/pkg", "../foo.ts")).toEqual(["~", "proj", "foo.ts"]);
    // An absolute link ignores the cwd.
    expect(resolveLinkPath("~/proj", "~/other/a.ts")).toEqual(["~", "other", "a.ts"]);
    // A cwd this side was never told cannot anchor a relative link.
    expect(resolveLinkPath("Session Plus", "src/foo.ts")).toBeNull();
  });
});

describe("relativeLinkSegments", () => {
  it("is the rootless reading of a link, and only of a relative one", () => {
    expect(relativeLinkSegments("src/foo.ts")).toEqual(["src", "foo.ts"]);
    expect(relativeLinkSegments("./pkg/./a.ts")).toEqual(["pkg", "a.ts"]);
    expect(relativeLinkSegments("pkg/sub/../a.ts")).toEqual(["pkg", "a.ts"]);
    // A place, not an offset: absolute forms are the other reading's business.
    expect(relativeLinkSegments("/etc/passwd")).toBeNull();
    expect(relativeLinkSegments("~/proj/a.ts")).toBeNull();
    // Climbing out of the root it would be descended from is not a candidate.
    expect(relativeLinkSegments("../a.ts")).toBeNull();
    expect(relativeLinkSegments("https://x/y")).toBeNull();
  });
});

describe("planWalk", () => {
  const roots = {
    roots: [
      { ref: "ref_proj", label: "proj", sourceLabel: "laptop", directoryKey: "dk1_proj" },
      { ref: "ref_other", label: "other", sourceLabel: "laptop", directoryKey: "dk1_other" },
    ],
    truncated: false,
  };
  const workspacesByDevice = {
    laptop: {
      device: "laptop",
      workspaces: [
        { id: "ws_0123456789abcdef01234567", label: "proj", display: "~/proj", directoryKey: "dk1_proj" },
        { id: "ws_0123456789abcdef01234568", label: "deep", display: "~/proj/deep", directoryKey: "dk1_other" },
      ],
    },
  };
  const session = { deviceId: "laptop", cwdDisplay: "~/proj", directoryKey: "dk1_proj" };

  function first(plan: ReturnType<typeof planWalk>): WalkCandidate {
    if (!plan.ok) throw new Error(`expected candidates, got: ${plan.message}`);
    return plan.candidates[0];
  }

  it("starts at the joined root and hands back the remaining segments", () => {
    const plan = planWalk({ target: ["~", "proj", "src", "a.ts"], session, workspacesByDevice, roots });
    expect(first(plan)).toMatchObject({ rootRef: "ref_proj", segments: ["src", "a.ts"], via: "key" });
  });

  it("uses the execution device's workspace rows for a remotely placed session", () => {
    const plan = planWalk({
      target: ["~", "proj", "src", "a.ts"],
      session: { ...session, deviceId: "runtime-a", directoryDeviceId: "laptop" },
      workspacesByDevice,
      roots,
    });
    expect(first(plan)).toMatchObject({ rootRef: "ref_proj", segments: ["src", "a.ts"], via: "key" });
  });

  it("prefers the DEEPEST containing base", () => {
    const plan = planWalk({ target: ["~", "proj", "deep", "x.ts"], session, workspacesByDevice, roots });
    expect(first(plan)).toMatchObject({ rootRef: "ref_other", segments: ["x.ts"], via: "key" });
  });

  it("anchors on the session's own cwd key when no workspace row matches", () => {
    const plan = planWalk({
      target: ["~", "proj", "a.ts"],
      session,
      workspacesByDevice: {},
      roots,
    });
    expect(first(plan)).toMatchObject({ rootRef: "ref_proj", segments: ["a.ts"], via: "key" });
  });

  it("keeps the exact-key anchor when an absolute href spells a home-relative cwd", () => {
    const plan = planWalk({
      target: ["", "home", "ubuntu", "lht", "project-x", "talk-design-en.md"],
      session: {
        deviceId: "laptop",
        cwdDisplay: "~/lht/project-x",
        directoryKey: "dk1_proj",
      },
      workspacesByDevice: {},
      // The friendly label "proj" does not occur in the canonical path.
      roots,
    });
    expect(first(plan)).toMatchObject({
      rootRef: "ref_proj",
      segments: ["talk-design-en.md"],
      via: "key",
    });
  });

  it("does not turn an unrelated absolute path into a key-exact candidate", () => {
    const plan = planWalk({
      target: ["", "srv", "somewhere-else", "talk-design-en.md"],
      session: {
        deviceId: "laptop",
        cwdDisplay: "~/lht/project-x",
        directoryKey: "dk1_proj",
      },
      workspacesByDevice: {},
      roots,
    });
    expect(plan).toEqual({
      ok: false,
      message: "在已登记的工作区根里找不到这个路径的起点；请在左侧目录索引中打开它所在的工作区后再试。",
    });
  });

  it("opens an absolute path from the authenticated owner Runner root without a workspace join", () => {
    const plan = planWalk({
      target: ["", "srv", "private", "AUTONOMOUS-ROADMAP.md"],
      session: { deviceId: "laptop", cwdDisplay: "/srv/private" },
      workspacesByDevice: {},
      roots: {
        roots: [{ ref: "ref_owner_root", label: "/", sourceLabel: "laptop" }],
        truncated: false,
      },
    });
    expect(first(plan)).toEqual({
      rootRef: "ref_owner_root",
      rootLabel: "/",
      segments: ["srv", "private", "AUTONOMOUS-ROADMAP.md"],
      via: "owner",
    });
  });

  it("falls back to a root whose LABEL appears in the path when no key joins", () => {
    // Nothing carries a directoryKey: the join is impossible, the click is not.
    const plan = planWalk({
      target: ["~", "work", "proj", "src", "a.ts"],
      relative: ["src", "a.ts"],
      session: { deviceId: "laptop", cwdDisplay: "~/work/proj" },
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [{ id: "ws_0123456789abcdef01234567", label: "proj", display: "~/work/proj" }],
        },
      },
      roots: { roots: [{ ref: "ref_proj", label: "proj", sourceLabel: "laptop" }], truncated: false },
    });
    expect(first(plan)).toMatchObject({ rootRef: "ref_proj", segments: ["src", "a.ts"], via: "label" });
  });

  it("keeps the key-exact candidate FIRST and the guesses after it", () => {
    const plan = planWalk({
      target: ["~", "proj", "src", "a.ts"],
      relative: ["src", "a.ts"],
      session,
      workspacesByDevice,
      roots,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.candidates[0].via).toBe("key");
    expect(plan.candidates.map((row) => row.via).slice(1).every((via) => via !== "key")).toBe(true);
    // Every candidate starts at a ref the provider minted — never a fabricated one.
    expect(plan.candidates.every((row) => row.rootRef === "ref_proj" || row.rootRef === "ref_other")).toBe(true);
  });

  it("offers the relative link under every root when the cwd could not anchor it", () => {
    const plan = planWalk({
      target: null,
      relative: ["src", "a.ts"],
      session: { deviceId: "laptop", cwdDisplay: "Session Plus" },
      workspacesByDevice: {},
      roots,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.candidates).toEqual([
      { rootRef: "ref_proj", rootLabel: "proj", segments: ["src", "a.ts"], via: "root" },
      { rootRef: "ref_other", rootLabel: "other", segments: ["src", "a.ts"], via: "root" },
    ]);
  });

  it("refuses without inventing anything when there is nowhere to start", () => {
    const empty = planWalk({
      target: ["~", "proj", "a.ts"],
      session,
      workspacesByDevice,
      roots: { roots: [], truncated: false },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("没有任何可浏览的工作区根");

    const nowhere = planWalk({
      target: ["~", "elsewhere", "a.ts"],
      session,
      workspacesByDevice: {},
      roots: { roots: [{ ref: "ref_x", label: "x", sourceLabel: "laptop" }], truncated: false },
    });
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.message).toContain("找不到这个路径的起点");
  });

  it("calls a directory endpoint a directory, honestly", () => {
    const plan = planWalk({ target: ["~"], session, workspacesByDevice, roots });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain("目录");
  });
});

describe("walkToFile", () => {
  const listings = new Map<string, { entries: Array<Record<string, unknown>> }>([
    ["ref_root", { entries: [{ ref: "ref_src", label: "src", kind: "directory" }, { ref: "ref_link", label: "link", kind: "other" }] }],
    ["ref_src", { entries: [{ ref: "ref_a", label: "a.ts", kind: "file" }, { ref: "ref_sub", label: "sub", kind: "directory" }] }],
    ["ref_two", { entries: [{ ref: "ref_b", label: "b.ts", kind: "file" }] }],
  ]);
  function fakeList(calls: string[]): ListDirectory {
    return async (ref) => {
      calls.push(ref);
      const value = listings.get(ref);
      if (!value) return { ok: false, code: "approval_required", message: "要先在可信审批栏确认" };
      return { ok: true, value: { ref, label: ref, entries: value.entries as never, truncated: false } };
    };
  }
  const at = (rootRef: string, segments: string[], via: WalkCandidate["via"] = "key"): WalkCandidate => ({
    rootRef,
    rootLabel: rootRef,
    segments,
    via,
  });

  it("descends by listed labels and answers with the file's own ref", async () => {
    const calls: string[] = [];
    const out = await walkToFile({ list: fakeList(calls) }, { ok: true, candidates: [at("ref_root", ["src", "a.ts"])] });
    expect(out).toMatchObject({ ok: true, ref: "ref_a", label: "a.ts" });
    // One listing per level: the walk never re-lists and never guesses a ref.
    expect(calls).toEqual(["ref_root", "ref_src"]);
  });

  it("moves to the next candidate when a listing simply has no such entry", async () => {
    const calls: string[] = [];
    const out = await walkToFile({ list: fakeList(calls) }, {
      ok: true,
      candidates: [at("ref_root", ["b.ts"], "label"), at("ref_two", ["b.ts"], "root")],
    });
    expect(out).toMatchObject({ ok: true, ref: "ref_b", candidate: { rootRef: "ref_two", via: "root" } });
    expect(calls).toEqual(["ref_root", "ref_two"]);
  });

  it("surfaces a refusal verbatim and stops — a retry would be a second approval card", async () => {
    const calls: string[] = [];
    const out = await walkToFile({ list: fakeList(calls) }, {
      ok: true,
      candidates: [at("ref_root", ["src", "sub", "x.ts"]), at("ref_two", ["b.ts"])],
    });
    expect(out).toEqual({ ok: false, message: "要先在可信审批栏确认" });
    expect(calls).toEqual(["ref_root", "ref_src", "ref_sub"]);
  });

  it("says when a segment does not exist anywhere it looked", async () => {
    const one = await walkToFile({ list: fakeList([]) }, { ok: true, candidates: [at("ref_root", ["missing.ts"])] });
    expect(one).toEqual({ ok: false, message: "路径不存在或不可见：missing.ts" });

    const many = await walkToFile({ list: fakeList([]) }, {
      ok: true,
      candidates: [at("ref_root", ["missing.ts"]), at("ref_two", ["missing.ts"])],
    });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.message).toContain("已在 2 个工作区起点里找过");
  });

  it("refuses to walk THROUGH a non-directory and to open a non-file", async () => {
    const through = await walkToFile({ list: fakeList([]) }, { ok: true, candidates: [at("ref_root", ["link", "x"])] });
    expect(through.ok).toBe(false);
    const endpoint = await walkToFile({ list: fakeList([]) }, { ok: true, candidates: [at("ref_root", ["link"])] });
    expect(endpoint).toEqual({ ok: false, message: "该路径不是可打开的文本文件。" });
    const dir = await walkToFile({ list: fakeList([]) }, { ok: true, candidates: [at("ref_root", ["src"])] });
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.message).toContain("目录");
  });
});

describe("walkToFile over a resolving port (ticket #243)", () => {
  const at = (rootRef: string, segments: string[], via: WalkCandidate["via"] = "key"): WalkCandidate => ({
    rootRef,
    rootLabel: rootRef,
    segments,
    via,
  });
  const noList: ListDirectory = async () => {
    throw new Error("the per-level walk must not run when the port resolves");
  };
  function fakeResolve(
    answers: Record<string, Awaited<ReturnType<ResolveEntry>>>,
    calls: string[] = [],
  ): ResolveEntry {
    return async (rootRef, labels) => {
      const key = `${rootRef} ${labels.join("/")}`;
      calls.push(key);
      return answers[key] ?? { ok: false, code: "not_found", message: `路径不存在或不可见：${labels[labels.length - 1]}` };
    };
  }

  it("spends one call per candidate and answers with the resolved ref", async () => {
    const calls: string[] = [];
    const resolve = fakeResolve({
      "ref_root src/a.ts": { ok: true, value: { ref: "ref_a", label: "a.ts", kind: "file" } },
    }, calls);
    const out = await walkToFile({ list: noList, resolve }, {
      ok: true,
      candidates: [at("ref_root", ["src", "a.ts"])],
    });
    expect(out).toMatchObject({ ok: true, ref: "ref_a", label: "a.ts" });
    expect(calls).toEqual(["ref_root src/a.ts"]);
  });

  it("moves to the next candidate on not_found, and reports how many it tried", async () => {
    const calls: string[] = [];
    const resolve = fakeResolve({
      "ref_two b.ts": { ok: true, value: { ref: "ref_b", label: "b.ts", kind: "file" } },
    }, calls);
    const found = await walkToFile({ list: noList, resolve }, {
      ok: true,
      candidates: [at("ref_root", ["b.ts"], "label"), at("ref_two", ["b.ts"], "root")],
    });
    expect(found).toMatchObject({ ok: true, ref: "ref_b", candidate: { via: "root" } });
    expect(calls).toEqual(["ref_root b.ts", "ref_two b.ts"]);

    const nowhere = await walkToFile({ list: noList, resolve: fakeResolve({}) }, {
      ok: true,
      candidates: [at("ref_root", ["missing.ts"]), at("ref_two", ["missing.ts"])],
    });
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.message).toContain("已在 2 个工作区起点里找过");
  });

  it("stops the whole click on a real refusal — approval_required above all", async () => {
    const calls: string[] = [];
    const resolve: ResolveEntry = async (rootRef, labels) => {
      calls.push(`${rootRef} ${labels.join("/")}`);
      return { ok: false, code: "approval_required", message: "要先在可信审批栏确认" };
    };
    const out = await walkToFile({ list: noList, resolve }, {
      ok: true,
      candidates: [at("ref_root", ["src", "x.ts"]), at("ref_two", ["src", "x.ts"])],
    });
    expect(out).toEqual({ ok: false, message: "要先在可信审批栏确认" });
    expect(calls).toEqual(["ref_root src/x.ts"]);
  });

  it("keeps the honest sentences for a directory endpoint and a non-file", async () => {
    const dir = await walkToFile({
      list: noList,
      resolve: fakeResolve({
        "ref_root src": { ok: true, value: { ref: "ref_src", label: "src", kind: "directory" } },
      }),
    }, { ok: true, candidates: [at("ref_root", ["src"])] });
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.message).toContain("目录");

    const link = await walkToFile({
      list: noList,
      resolve: fakeResolve({
        "ref_root link": { ok: false, code: "not_a_file", message: "该路径不是可打开的文本文件。" },
      }),
    }, { ok: true, candidates: [at("ref_root", ["link"])] });
    expect(link).toEqual({ ok: false, message: "该路径不是可打开的文本文件。" });
  });

  it("treats not_a_directory as this candidate missing, not as a terminal refusal", async () => {
    const resolve = fakeResolve({
      "ref_root link/x": { ok: false, code: "not_a_directory", message: "link 不是可进入的目录。" },
      "ref_two link/x": { ok: true, value: { ref: "ref_x", label: "x", kind: "file" } },
    });
    const out = await walkToFile({ list: noList, resolve }, {
      ok: true,
      candidates: [at("ref_root", ["link", "x"]), at("ref_two", ["link", "x"], "root")],
    });
    expect(out).toMatchObject({ ok: true, ref: "ref_x" });
  });
});
