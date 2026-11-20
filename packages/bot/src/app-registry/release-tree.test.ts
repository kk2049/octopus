/**
 * Which tree a publication is packed from, as ordering rules a test can hold.
 *
 * The property that matters is not "prefer X": it is that a tree is only chosen
 * when it can ACTUALLY be packed (deps and build present) and actually carries
 * the change (the commit is in its history), and that the refusal distinguishes
 * "a deploy would fix this" from "nothing here can be packed" — because the
 * first is a wait with a known ending and the second is a person's problem.
 */

import { describe, expect, it } from "vitest";
import { chooseReleaseTree, type ReleaseTreeCandidate } from "./release-tree.js";

const WORKTREE = "/w/ticket-61";
const DEPLOYED = "/w/run";
const BOTH: ReleaseTreeCandidate[] = [
  { kind: "deployed", dir: DEPLOYED },
  { kind: "worktree", dir: WORKTREE },
];

const has = (...dirs: string[]) => (dir: string) => dirs.includes(dir);

describe("chooseReleaseTree", () => {
  it("takes the deployed tree when it already carries the commit", () => {
    const choice = chooseReleaseTree({
      sha: "abc",
      candidates: BOTH,
      contains: has(DEPLOYED, WORKTREE),
      built: has(DEPLOYED, WORKTREE),
    });
    expect(choice.ok && choice.kind).toBe("deployed");
    expect(choice.ok && choice.why).toContain("同一个 commit");
  });

  it("falls through to the ticket worktree when the deploy is behind", () => {
    const choice = chooseReleaseTree({
      sha: "abc",
      candidates: BOTH,
      contains: has(WORKTREE),
      built: has(DEPLOYED, WORKTREE),
    });
    expect(choice.ok && choice.kind).toBe("worktree");
  });

  it("skips a tree that has the commit but cannot be packed", () => {
    // The ordinary-ticket shape: the worktree is newest and has no node_modules.
    const choice = chooseReleaseTree({
      sha: "abc",
      candidates: BOTH,
      contains: has(DEPLOYED, WORKTREE),
      built: has(DEPLOYED),
    });
    expect(choice.ok && choice.kind).toBe("deployed");
  });

  it("says a deploy is what unblocks it when only the commit is missing", () => {
    const choice = chooseReleaseTree({
      sha: "abc",
      candidates: BOTH,
      contains: () => false,
      built: has(DEPLOYED, WORKTREE),
    });
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.awaitingDeploy).toBe(true);
    expect(choice.why).toContain("还没有这个 commit");
  });

  it("does not blame the deploy when the deployed tree was never offered", () => {
    const choice = chooseReleaseTree({
      sha: "abc",
      candidates: [{ kind: "worktree", dir: WORKTREE }],
      contains: () => false,
      built: has(WORKTREE),
    });
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.awaitingDeploy).toBe(false);
  });

  it("ignores history when no commit was named", () => {
    const choice = chooseReleaseTree({
      sha: null,
      candidates: BOTH,
      contains: () => false,
      built: has(DEPLOYED),
    });
    expect(choice.ok && choice.kind).toBe("deployed");
  });

  it("refuses with both reasons when nothing is usable", () => {
    const choice = chooseReleaseTree({
      sha: "abc",
      candidates: BOTH,
      contains: has(DEPLOYED),
      built: () => false,
    });
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.why).toContain("没有可用的依赖/构建产物");
    expect(choice.why).toContain("还没有这个 commit");
  });
});
