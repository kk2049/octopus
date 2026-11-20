import { describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import { associateCiRangeCommits, renderCiChangeHistory } from "./ci-change-history.js";

function seed() {
  const store = new Store(":memory:");
  store.saveUser({ username: "lht", uid: 1, home_dir: "/home/ubuntu", created_at: "2026-08-17T00:00:00Z" });
  const t = store.devTickets.createDevTicket({
    title: "把 Session Plus release fixture 隔离",
    body: "全量套件里 release 模块被别的文件写过,先隔离 fixture",
    requester: "lht",
    kind: "simple",
    app_id: null,
    model: "claude-opus-5",
    effort: "high",
  });
  store.devTickets.addTicketMessage(t.id, "agent", "agent", "改了 fixture,单独跑绿了;没有在批次里验证过。");
  store.devTickets.updateDevTicket(t.id, { commit_sha: "aaaa111122223333", branch: `ticket/${t.id}-fixture` });
  return { store, t };
}

describe("what a repair ticket is told about the range", () => {
  it("carries the requester's ask AND the agent's own summary, not just a subject line", () => {
    const { store, t } = seed();
    const out = renderCiChangeHistory(store, "green0", "red9", [
      { sha: "aaaa111122223333", subject: "test(session-plus): isolate fixture", ticketId: t.id },
    ]);
    expect(out).toContain("green0");
    expect(out).toContain("aaaa111122");
    expect(out).toContain(`工单 #${t.id}`);
    // The two things a commit message does not have.
    expect(out).toContain("release 模块被别的文件写过");
    expect(out).toContain("没有在批次里验证过");
  });

  it("says so when the range is empty, and points away from editing assertions", () => {
    const { store } = seed();
    const out = renderCiChangeHistory(store, "green0", "red9", []);
    expect(out).toContain("没有 commit");
    expect(out).toContain("不要为它改断言");
  });

  it("lists every commit in the nightly range", () => {
    const { store } = seed();
    const many = Array.from({ length: 45 }, (_, i) => ({
      sha: `${i}`.padStart(40, "0"),
      subject: `commit ${i}`,
    }));
    const out = renderCiChangeHistory(store, "green0", "red9", many);
    expect(out).toContain("commit 0");
    expect(out).toContain("commit 44");
    expect(out).not.toContain("未列出");
  });

  it("associates every commit in each multi-commit landing with its ticket", () => {
    const { store, t } = seed();
    const newer = store.devTickets.createDevTicket({
      title: "新改动",
      body: "原始输入",
      requester: "lht",
      kind: "simple",
      app_id: null,
      model: "claude-opus-5",
      effort: "high",
    });
    store.devTickets.updateDevTicket(newer.id, { commit_sha: "cccc333344445555", branch: `ticket/${newer.id}-newer` });
    const commits = associateCiRangeCommits(store, [
      { sha: "cccc333344445555", subject: "newer tip" },
      { sha: "bbbb222233334444", subject: "newer first" },
      { sha: "aaaa111122223333", subject: "older tip" },
      { sha: "9999000011112222", subject: "older first" },
    ]);
    expect(commits.map((c) => c.ticketId)).toEqual([newer.id, newer.id, t.id, t.id]);
  });

  it("labels a CLI delivery body as its modification-result report", () => {
    const { store } = seed();
    const cli = store.devTickets.createDevTicket({
      title: "CLI 交付",
      body: "修改了超时预算并通过冷启动验证",
      requester: "lht",
      kind: "cli",
      app_id: null,
      model: "omp-gpt-5.6-sol",
      effort: "high",
    });
    const out = renderCiChangeHistory(store, "green0", "red9", [
      { sha: "dddd444455556666", subject: "Raise timeout", ticketId: cli.id },
    ]);
    expect(out).toContain("**修改结果报告**");
    expect(out).toContain("修改了超时预算");
    expect(out).not.toContain("这张票没有 agent 总结");
  });
});
