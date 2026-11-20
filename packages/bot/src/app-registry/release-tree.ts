/**
 * Which checkout do we pack an App release out of?
 *
 * ── Why this is a decision and not a constant ───────────────────────────────
 *
 * Three trees on this host can legitimately hold the code an App release should
 * be built from, and they are routinely at three different commits:
 *
 *   · the TICKET's worktree — newest, but built only if something built it (an
 *     app ticket's trimmed gate does; an ordinary ticket's worktree usually has
 *     no `node_modules` at all, and the packer refuses a stale or missing
 *     `dist/` rather than shipping one);
 *   · the DEPLOYED run tree — always installed and built, because the deploy
 *     did it, and always exactly the code the trusted process is running;
 *   · the primary reference worktree — clean, but nothing builds it.
 *
 * The packer recomputes the View source digest and fails closed on staleness,
 * so "which tree" is never a correctness risk — it is a question of whether the
 * publication can happen NOW or has to wait. This module answers that, once,
 * for every caller (the ticket tool, the CLI, and the after-deploy sweep), so
 * the three cannot drift into three different opinions about it.
 *
 * ── The framework dependency, stated as a rule ──────────────────────────────
 *
 * A release built from tree T is prepared by the platform running in THIS
 * process. When T is ahead of the process — an App change that needs trusted
 * code that has not been deployed yet — `activate()` fails closed and the
 * publication has to ride the next deploy. Packing the DEPLOYED tree instead is
 * the case where that dependency cannot exist: the View and the platform come
 * from the same commit by construction. That is why the deployed tree is the
 * preferred source once it carries the change, and why "the deployed tree does
 * not have your commit yet" is a WAIT rather than a failure.
 *
 * Pure on purpose: the two probes are injected, so the ordering rules are a
 * unit test rather than a thing you have to have three checkouts to observe.
 */

/** A tree the caller is willing to pack, in preference order. */
export interface ReleaseTreeCandidate {
  kind: "worktree" | "deployed";
  dir: string;
}

export interface ReleaseTreeChoice {
  ok: true;
  kind: ReleaseTreeCandidate["kind"];
  dir: string;
  /** One sentence naming why this tree, for the ticket conversation. */
  why: string;
}

export interface NoReleaseTree {
  ok: false;
  /** True when a deploy is what would make a tree usable. */
  awaitingDeploy: boolean;
  why: string;
}

export interface ChooseReleaseTreeInput {
  /** The commit the publication is about. Null = "whatever the tree has". */
  sha: string | null;
  candidates: readonly ReleaseTreeCandidate[];
  /** Does this tree's HEAD contain that commit? */
  contains(dir: string, sha: string): boolean;
  /** Can `pnpm run <pack script>` even run here (deps installed, build present)? */
  built(dir: string): boolean;
}

const LABEL: Record<ReleaseTreeCandidate["kind"], string> = {
  worktree: "工单自己的 worktree",
  deployed: "已部署的 run checkout",
};

export function chooseReleaseTree(input: ChooseReleaseTreeInput): ReleaseTreeChoice | NoReleaseTree {
  const missingBuild: string[] = [];
  const missingCommit: string[] = [];
  for (const candidate of input.candidates) {
    if (input.sha && !input.contains(candidate.dir, input.sha)) {
      missingCommit.push(LABEL[candidate.kind]);
      continue;
    }
    if (!input.built(candidate.dir)) {
      missingBuild.push(LABEL[candidate.kind]);
      continue;
    }
    return {
      ok: true,
      kind: candidate.kind,
      dir: candidate.dir,
      why:
        candidate.kind === "deployed"
          ? "从已部署的 run checkout 打包：它的 View 与正在运行的可信代码来自同一个 commit，不存在「新 View 依赖还没上线的框架」这种错配。"
          : "从工单自己的 worktree 打包：它是最新的，而且已经装好依赖并构建过。",
    };
  }
  // Only a deploy can fix "the run tree does not have this commit"; nothing
  // else in this list is worth telling an agent to go and do.
  const awaitingDeploy = missingCommit.includes(LABEL.deployed);
  const parts: string[] = [];
  if (missingCommit.length) parts.push(`还没有这个 commit：${missingCommit.join("、")}`);
  if (missingBuild.length) parts.push(`没有可用的依赖/构建产物：${missingBuild.join("、")}`);
  if (!parts.length) parts.push("没有任何可打包的 checkout");
  return { ok: false, awaitingDeploy, why: parts.join("；") };
}
