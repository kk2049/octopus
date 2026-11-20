/**
 * What the panel says Dev Factory can do, and what it offers you to do about it.
 *
 * The contract in this phase is deliberately NOT least privilege: the dev agent
 * runs as the bot process's own OS account with `--dangerously-skip-permissions`,
 * and the only real limit is who is given `dev`. That is a defensible position
 * to take on purpose — and an indefensible one to imply otherwise about, which
 * is what the old copy did: it listed "工作区固定在每张工单自己的 git worktree 内"
 * as a boundary, next to a claim that the merge path was the only way to the
 * baseline. Both describe an intended workflow. Neither constrains a process
 * with a shell.
 *
 * Someone reads that list to decide whether to hand out `dev`. So the wording is
 * a security property, and it is pinned here rather than left to review.
 */

import { describe, it, expect } from "vitest";
import { DEV_FACTORY_SUBJECT, DEV_FACTORY_INVENTORY_NOTE, SESSION_HUB_SUBJECT } from "./catalog.js";

const boundaries = DEV_FACTORY_SUBJECT.trustedService!.boundaries.join("\n");

describe("the Dev Factory security contract is stated truthfully", () => {
  it("names the real privilege: the host account, with permission checks off", () => {
    expect(boundaries).toContain("--dangerously-skip-permissions");
    expect(boundaries).toContain("OS 账号");
    expect(DEV_FACTORY_INVENTORY_NOTE).toContain("--dangerously-skip-permissions");
  });

  it("says the worktree is a working directory, not a sandbox", () => {
    // The specific sentence that has to be gone, and the one that replaced it.
    expect(boundaries).not.toContain("工作区固定在每张工单自己的 git worktree 内");
    expect(boundaries).toMatch(/worktree 是.*工作目录，不是沙箱/);
    expect(DEV_FACTORY_INVENTORY_NOTE).not.toContain("固定 repo/worktree");
  });

  it("presents the merge path as a convention rather than as a barrier", () => {
    // devpipe_submit is still described — it is how "tested == landed" holds —
    // but it is not offered as something that contains this agent.
    expect(boundaries).toContain("devpipe_submit");
    expect(boundaries).toMatch(/不是一道能拦住这个 agent 的技术边界/);
  });

  it("names the boundary that IS real: admission, with deploy kept separate", () => {
    expect(boundaries).toMatch(/边界是准入/);
    expect(boundaries).toContain("dev");
    expect(boundaries).toContain("deploy");
    expect(DEV_FACTORY_SUBJECT.description).toContain("只有被授予 dev 的人能用它");
  });

  it("does not pretend privilege reduction has happened", () => {
    expect(boundaries).toMatch(/去特权化设计推迟/);
    // `enforced: false` is what stops the page rendering controls for it.
    expect(DEV_FACTORY_SUBJECT.enforced).toBe(false);
    expect(DEV_FACTORY_SUBJECT.trustedService!.principal).toBe("system:dev-factory");
  });
});

describe("and the catalogue is what stops the page offering a grant control", () => {
  // The rule the browser reads: a subject gets controls only when it is not a
  // trusted service AND route policy marked it user-manageable. Both halves are
  // catalogue facts, which is why they are pinned here; the rendering half —
  // "a trusted service shows no save or revoke button, even to an admin" — is a
  // component test in `packages/dashboard-web/src/pages/PermissionsPage.test.tsx`.
  it("marks the dev factory unenforced, which is what withholds the controls", () => {
    expect(DEV_FACTORY_SUBJECT.enforced).toBe(false);
    expect(DEV_FACTORY_SUBJECT.trustedService).toBeDefined();
  });

  it("labels the list as what it HAS, not as a boundary it is held to", () => {
    expect(DEV_FACTORY_SUBJECT.trustedService!.boundaries.length).toBeGreaterThan(0);
    expect(boundaries).not.toContain("固定边界（不是通过普通授权取得的）");
  });

  it("still gives the session hub its controls — the contrast that makes this a rule", () => {
    // Without this, "no buttons anywhere" would also satisfy the rule above.
    expect(SESSION_HUB_SUBJECT.enforced).toBe(true);
    expect(SESSION_HUB_SUBJECT.trustedService).toBeUndefined();
  });
});
