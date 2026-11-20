import { describe, expect, it } from "vitest";
import {
  GITLAB_MR_DESCRIPTION_MAX,
  GITLAB_NOTE_MAX,
  GITLAB_TITLE_MAX,
  GitLabContribPublisher,
  gitlabTextParts,
} from "./gitlab-contrib.js";

function recorder() {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://gitlab.test/api/v4", "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method: init?.method ?? "GET", path, ...(body ? { body } : {}) });
    const payload = init?.method === "POST" && path.endsWith("/merge_requests")
      ? { iid: 7, web_url: "https://gitlab.test/mr/7", state: "opened" }
      : path.includes("merge_requests?state=opened") ? [] : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const publisher = new GitLabContribPublisher({ repoDir: "/nonexistent", apiUrl: "https://gitlab.test/api/v4", project: 1, token: "t", fetchFn });
  return { calls, publisher };
}

describe("GitLab text limits", () => {
  it("splits without losing or reordering characters and never inside a surrogate pair", () => {
    const text = "a" + "😀".repeat(10);
    const parts = gitlabTextParts(text, 4);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 4 && !/^[\udc00-\udfff]/.test(part))).toBe(true);
  });

  it("keeps a description over GitLab's limit whole, continuing it in notes", async () => {
    const { calls, publisher } = recorder();
    const description = "开头。" + "x".repeat(GITLAB_MR_DESCRIPTION_MAX + 500_000) + "最后一句。";
    await publisher.openMergeRequest({ branch: "contrib/1", targetBranch: "v4", title: "t", description });
    const created = calls.find((call) => call.method === "POST" && call.path.endsWith("/merge_requests"))!;
    const head = String(created.body!.description);
    expect(head.length).toBeLessThanOrEqual(GITLAB_MR_DESCRIPTION_MAX);
    expect(head).toContain("continues in the next 1 comment");
    const notes = calls.filter((call) => call.path.endsWith("/merge_requests/7/notes"));
    expect(notes).toHaveLength(1);
    const note = String(notes[0]!.body!.body);
    expect(note.length).toBeLessThanOrEqual(GITLAB_NOTE_MAX);
    const body = (text: string) => text.replace(/\n\n\(Description continues[\s\S]*$/, "").replace(/^\(Description, continued [^)]*\)\n\n/, "");
    expect(body(head) + body(note)).toBe(description);
  });

  it("shortens an over-long title visibly and states it whole", async () => {
    const { calls, publisher } = recorder();
    const title = "t".repeat(GITLAB_TITLE_MAX + 10);
    await publisher.openMergeRequest({ branch: "contrib/1", targetBranch: "v4", title, description: "d" });
    const created = calls.find((call) => call.method === "POST" && call.path.endsWith("/merge_requests"))!;
    expect(String(created.body!.title)).toHaveLength(GITLAB_TITLE_MAX);
    expect(String(created.body!.title).endsWith("…")).toBe(true);
    expect(String(created.body!.description)).toContain(`Full title: ${title}`);
  });

  it("posts a long closing note as several notes before closing", async () => {
    const { calls, publisher } = recorder();
    const note = "n".repeat(GITLAB_NOTE_MAX * 2);
    await publisher.closeMergeRequest(7, note);
    const posted = calls.filter((call) => call.path.endsWith("/merge_requests/7/notes")).map((call) => String(call.body!.body));
    expect(posted.length).toBe(3);
    expect(posted.every((body) => body.length <= GITLAB_NOTE_MAX)).toBe(true);
    expect(posted.map((body) => body.replace(/^\(\d+\/\d+\)\n\n/, "")).join("")).toBe(note);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { state_event: "close" } });
  });
});
