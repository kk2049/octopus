import { describe, expect, it } from "vitest";
import type { DirectoryState } from "@claude-bot/agent-workspace-files-view";
import type { WorkspaceFilesRootsV2 } from "@claude-bot/workspace-files-contract";
import { homeDirectoryRows, homePathSegments, planFileReveal, planWorkspaceReveal, type HomeDirectoryTreeInput } from "./home-directory-tree.js";

const ROOT = "dk1_aaaaaaaaaaaaaaaa";
const OTHER = "dk1_bbbbbbbbbbbbbbbb";
const HOME = "dk1_cccccccccccccccc";

type FixtureInput = Omit<HomeDirectoryTreeInput, "roots"> & { roots: WorkspaceFilesRootsV2 | null };
function input(over: Partial<FixtureInput> = {}): FixtureInput {
  return {
    roots: {
      roots: [
        { ref: "ref_octopus", label: "Octopus", sourceLabel: "我的电脑", directoryKey: ROOT },
        { ref: "ref_notes", label: "Notes", sourceLabel: "我的电脑", directoryKey: OTHER },
      ],
      truncated: false,
    },
    workspacesByDevice: {
      laptop: {
        device: "laptop",
        workspaces: [
          { id: "ws_a", label: "Octopus", display: "~/work/octopus", directoryKey: ROOT },
          { id: "ws_b", label: "Notes", display: "~/work/notes", directoryKey: OTHER },
        ],
      },
    },
    cache: new Map(),
    expandedDirs: new Set(),
    expanded: {},
    ...over,
  };
}

describe("home-rooted workspace navigation", () => {
  it("shares display ancestors instead of presenting every workspace as a loose root", () => {
    const rows = homeDirectoryRows(input());
    expect(rows.map((row) => row.type === "directory" ? `${row.depth}:${row.label}` : row.type))
      .toEqual(["device", "0:~", "1:work", "2:notes", "2:octopus"]);
    expect(rows.filter((row) => row.type === "directory" && row.label === "work")).toHaveLength(1);
  });

  it("opens the registry index by default and leaves every listing-backed row closed", () => {
    // The two defaults answer different questions, and after ticket #350 they
    // can no longer describe the same coordinate: `~` and `work` carry no root,
    // so their children ARE the registry and there is nothing to fetch, while
    // opening a registered workspace spends a `listDirectory` call.
    const nodes = homeDirectoryRows(input()).flatMap((row) => row.type === "directory"
      ? [{ label: row.label, backed: row.root !== null, open: row.open }]
      : []);
    expect(nodes).toEqual([
      { label: "~", backed: false, open: true },
      { label: "work", backed: false, open: true },
      { label: "notes", backed: true, open: false },
      { label: "octopus", backed: true, open: false },
    ]);
  });

  it("keeps a newly registered device visible before it has any workspace roots", () => {
    const rows = homeDirectoryRows(input({
      roots: { roots: [], truncated: false },
      workspacesByDevice: {
        macbookpro: { device: "macbookpro", workspaces: [] },
      },
    }));

    expect(rows).toEqual([
      {
        type: "device",
        key: "home-device:macbookpro",
        label: "macbookpro",
        terminalDevice: "macbookpro",
        open: true,
        total: 0,
      },
      {
        type: "directory",
        key: 'home:["macbookpro"]',
        label: "~",
        depth: 0,
        open: true,
        root: null,
        launch: { device: "macbookpro", directory: "~" },
      },
    ]);
  });

  it("folds a nested registered root into the upper file row at the same home location", () => {
    const rows = homeDirectoryRows(input({
      roots: {
        roots: [
          { ref: "ref_home", label: "Home", sourceLabel: "我的电脑", directoryKey: HOME },
          { ref: "ref_lht", label: "lht", sourceLabel: "我的电脑", directoryKey: ROOT },
        ],
        truncated: false,
      },
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [
            { id: "ws_home", label: "Home", display: "~", directoryKey: HOME },
            { id: "ws_lht", label: "lht", display: "~/lht", directoryKey: ROOT },
          ],
        },
      },
      cache: new Map([["ref_home", {
        status: "ready",
        value: {
          ref: "ref_home",
          label: "Home",
          directoryKey: HOME,
          entries: [{
            ref: "ref_lht_from_home",
            label: "lht",
            kind: "directory",
            directoryKey: "dk1_dddddddddddddddd",
          }],
          truncated: false,
        },
        message: "",
        code: "",
      }]]),
      expandedDirs: new Set(["ref_home"]),
    }));

    const lht = rows.filter((row) => row.type !== "device" && row.type !== "files" && row.label === "lht");
    expect(lht).toHaveLength(1);
    expect(lht[0]).toMatchObject({
      root: { ref: "ref_lht" },
      launch: { device: "laptop", directory: "~/lht" },
    });
  });

  /**
   * The bug from ticket #350, in the shape the reporter hit it.
   *
   * `~/lht/paper-work` is not a registered workspace; `~/lht/paper-work/phd`
   * is. That made `paper-work` a navigation node whose only knowledge of the
   * directory was "phd lives under here" — and it replaced the real listing
   * row, so the five sibling folders that exist on disk were simply absent from
   * the navigator with nothing saying so.
   */
  describe("a navigation node with no root of its own", () => {
    const NESTED = "dk1_dddddddddddddddd";
    const paperWork = (over: Record<string, unknown> = {}) => input({
      roots: {
        roots: [
          { ref: "ref_lht", label: "lht", sourceLabel: "我的电脑", directoryKey: ROOT },
          { ref: "ref_phd", label: "phd", sourceLabel: "我的电脑", directoryKey: NESTED },
        ],
        truncated: false,
      },
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [
            { id: "ws_lht", label: "lht", display: "~/lht", directoryKey: ROOT },
            { id: "ws_phd", label: "phd", display: "~/lht/paper-work/phd", directoryKey: NESTED },
          ],
        },
      },
      expanded: { "home-device:laptop": true, 'home:["laptop"]': true },
      ...over,
    });
    const listing = (ref: string, label: string, entries: readonly unknown[]) => [ref, {
      status: "ready",
      message: "",
      code: "",
      value: { ref, label, entries, truncated: false },
    }] as unknown as [string, DirectoryState];

    it("yields to the real listing row so the directory's actual contents stay browsable", () => {
      const rows = homeDirectoryRows(paperWork({
        cache: new Map([
          listing("ref_lht", "lht", [{ ref: "ref_pw", label: "paper-work", kind: "directory" }]),
        ]),
        expandedDirs: new Set(["ref_lht"]),
      }));

      const paper = rows.filter((row) => row.type === "files" && row.row.label === "paper-work");
      expect(paper).toHaveLength(1);
      expect(paper[0]).toMatchObject({
        row: { ref: "ref_pw", kind: "directory", expanded: false },
        launch: { device: "laptop", directory: "~/lht/paper-work" },
      });
      // Exactly one row for that coordinate: the navigation node no longer
      // draws a second one beside the listing row it used to replace.
      expect(rows.filter((row) => row.type === "directory" && row.label === "paper-work")).toHaveLength(0);
      // And its registered descendant is where it actually is — inside a folder
      // that has not been opened yet.
      expect(rows.some((row) => (row.type === "files" ? row.row.label : row.label) === "phd")).toBe(false);
    });

    it("folds the registered descendant back in once the real folder is opened", () => {
      const rows = homeDirectoryRows(paperWork({
        cache: new Map([
          listing("ref_lht", "lht", [{ ref: "ref_pw", label: "paper-work", kind: "directory" }]),
          listing("ref_pw", "paper-work", [
            { ref: "ref_phd_entry", label: "phd", kind: "directory", directoryKey: NESTED },
            { ref: "ref_review", label: "review", kind: "directory" },
            { ref: "ref_readme", label: "readme.md", kind: "file" },
          ]),
        ]),
        expandedDirs: new Set(["ref_lht", "ref_pw"]),
      }));

      expect(rows.filter((row) => row.type === "files").map((row) => row.type === "files" ? row.row.label : ""))
        .toEqual(["paper-work", "review", "readme.md"]);
      // `phd` keeps the REGISTERED root's ref rather than the entry ref the
      // listing carried: one row, addressed the way the person registered it.
      const phd = rows.filter((row) => row.type === "directory" && row.label === "phd");
      expect(phd).toHaveLength(1);
      expect(phd[0]).toMatchObject({ root: { ref: "ref_phd" }, depth: 3 });
    });

    it("drops dot entries from the listing while leaving the registered roots alone", () => {
      const cache = new Map([
        listing("ref_lht", "lht", [
          { ref: "ref_pw", label: "paper-work", kind: "directory" },
          { ref: "ref_git", label: ".git", kind: "directory" },
          { ref: "ref_env", label: ".env", kind: "file" },
        ]),
      ]);
      const shown = homeDirectoryRows(paperWork({ cache, expandedDirs: new Set(["ref_lht"]) }));
      expect(shown.filter((row) => row.type === "files").map((row) => row.type === "files" ? row.row.label : ""))
        .toEqual([".git", "paper-work", ".env"]);

      const hidden = homeDirectoryRows(paperWork({
        cache,
        expandedDirs: new Set(["ref_lht"]),
        hideDotEntries: true,
      }));
      expect(hidden.filter((row) => row.type === "files").map((row) => row.type === "files" ? row.row.label : ""))
        .toEqual(["paper-work"]);
      expect(hidden.some((row) => row.type === "directory" && row.label === "lht")).toBe(true);
    });
  });

  it("keeps external roots under an explicit .. hop", () => {
    const rows = homeDirectoryRows(input({
      roots: {
        roots: [{ ref: "ref_vault", label: "Vault", sourceLabel: "我的电脑", directoryKey: ROOT }],
        truncated: false,
      },
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [{ id: "ws_a", label: "Vault", display: "~/…/vault", directoryKey: ROOT }],
        },
      },
    }));
    expect(rows.map((row) => row.type === "directory" ? row.label : row.type))
      .toEqual(["device", "~", "..", "vault"]);
    expect(homePathSegments("~/../../srv", "srv")).toEqual(["..", "..", "srv"]);
  });

  it("uses exact keys to locate roots and puts an unjoined root under ..", () => {
    const rows = homeDirectoryRows(input({ workspacesByDevice: {} }));
    expect(rows.filter((row) => row.type === "directory" && row.label === "..")).toHaveLength(1);
    expect(rows.some((row) => row.type === "directory" && row.label === "work")).toBe(false);
  });

  it("honours synthetic expansion and keeps file expansion keyed by opaque ref", () => {
    const first = homeDirectoryRows(input());
    const work = first.find((row) => row.type === "directory" && row.label === "work");
    if (!work || work.type !== "directory") throw new Error("work row missing");
    const collapsed = homeDirectoryRows(input({ expanded: { [work.key]: false } }));
    expect(collapsed.some((row) => row.type === "directory" && row.label === "octopus")).toBe(false);

    const cache = new Map<string, DirectoryState>([["ref_octopus", {
      status: "ready",
      value: {
        ref: "ref_octopus",
        label: "Octopus",
        entries: [{ ref: "ref_src", label: "src", kind: "directory" }],
        truncated: false,
      } as never,
      message: "",
      code: "",
    }]]);
    const expanded = homeDirectoryRows(input({ cache, expandedDirs: new Set(["ref_octopus"]) }));
    expect(expanded.find((row) => row.type === "files" && row.row.label === "src")).toMatchObject({
      depth: 3,
      launch: { device: "laptop", directory: "~/work/octopus/src" },
    });
  });

  describe("desktop workspace reveal planning", () => {
    it("starts at the shallowest exact root and descends to an unregistered real cwd", () => {
      const result = planWorkspaceReveal({
        session: {
          deviceId: "runtime-a",
          directoryDeviceId: "laptop",
          cwdDisplay: "~/lht/paper-work",
          directoryKey: "dk1_session_paperwork",
        },
        roots: {
          roots: [
            { ref: "ref_lht", label: "lht", sourceLabel: "我的电脑", directoryKey: ROOT },
            { ref: "ref_phd", label: "phd", sourceLabel: "我的电脑", directoryKey: OTHER },
          ],
          truncated: false,
        } as never,
        workspacesByDevice: {
          laptop: {
            device: "laptop",
            workspaces: [
              { id: "ws_lht", label: "lht", display: "~/lht", directoryKey: ROOT },
              { id: "ws_phd", label: "phd", display: "~/lht/paper-work/phd", directoryKey: OTHER },
            ],
          },
        },
      });

      expect(result).toEqual({
        ok: true,
        plan: {
          rootRef: "ref_lht",
          steps: [{ label: "paper-work" }],
          expandedKeys: [
            "home-device:laptop",
            'home:["laptop"]',
            'home:["laptop","lht"]',
          ],
          display: "~/lht/paper-work",
          showHidden: false,
        },
      });
    });

    it("switches to an exact nested root even when its parent listing omits a directory key", () => {
      const result = planWorkspaceReveal({
        session: {
          deviceId: "laptop",
          cwdDisplay: "~/lht/paper-work",
          directoryKey: "dk1_session_paperwork",
        },
        roots: {
          roots: [
            { ref: "ref_home", label: "ubuntu", sourceLabel: "laptop", directoryKey: HOME },
            { ref: "ref_lht", label: "lht", sourceLabel: "laptop", directoryKey: ROOT },
          ],
          truncated: false,
        } as never,
        workspacesByDevice: {
          laptop: {
            device: "laptop",
            workspaces: [
              { id: "ws_home", label: "Home", display: "~", directoryKey: HOME },
              { id: "ws_lht", label: "lht", display: "~/lht", directoryKey: ROOT },
            ],
          },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        plan: {
          rootRef: "ref_home",
          steps: [
            { label: "lht", registeredRootRef: "ref_lht" },
            { label: "paper-work" },
          ],
        },
      });
    });

    it("never treats a matching-looking root label as the session workspace", () => {
      const result = planWorkspaceReveal({
        session: {
          deviceId: "laptop",
          cwdDisplay: "~/lht/paper-work",
          directoryKey: "dk1_session_paperwork",
        },
        roots: {
          roots: [{ ref: "ref_home", label: "ubuntu", sourceLabel: "laptop" }],
          truncated: false,
        },
        workspacesByDevice: {
          laptop: {
            device: "laptop",
            workspaces: [{
              id: "ws_phd",
              label: "phd",
              display: "~/lht/paper-work/phd",
              directoryKey: OTHER,
            }],
          },
        },
      });

      expect(result).toEqual({
        ok: false,
        message: "当前会话工作目录未与任何已登记文件根精确关联，无法安全定位。",
      });
    });
  });
});

it("changes the device heading without changing navigation and terminal identities", () => {
  const rows = homeDirectoryRows(input({ roots: { roots: [], truncated: false },
    workspacesByDevice: { macbookpro: { device: "macbookpro", deviceLabel: "aliyun", workspaces: [] } },
  }));
  expect(rows.find((row) => row.type === "device")).toMatchObject({
    key: "home-device:macbookpro", label: "aliyun", terminalDevice: "macbookpro",
  });
});


describe("file reveal planning", () => {
  it("uses the exact root and listing labels, including hidden file ancestors", () => {
    const result = planFileReveal({ ...input(), location: { rootRef: "ref_octopus", labels: [".hidden", "报告.pdf"] } });
    expect(result).toMatchObject({ ok: true, plan: {
      rootRef: "ref_octopus", steps: [{ label: ".hidden" }], display: "报告.pdf", showHidden: true,
    } });
  });
  it("keeps owner filesystem roots reachable without a session directory key", () => {
    expect(planFileReveal({
      roots: { roots: [{ ref: "owner", label: "/", sourceLabel: "laptop" }], truncated: false },
      workspacesByDevice: {}, location: { rootRef: "owner", labels: ["home", "report.pdf"] },
    })).toMatchObject({ ok: true, plan: {
      rootRef: "owner", steps: [{ label: "home" }],
      expandedKeys: expect.arrayContaining(['home-device:laptop', 'home:["laptop","..","/"]']),
    } });
  });
  it("refuses a missing root rather than substituting a matching label", () => {
    expect(planFileReveal({ ...input(), location: { rootRef: "missing", labels: ["Octopus", "report.pdf"] } }).ok).toBe(false);
  });
});
