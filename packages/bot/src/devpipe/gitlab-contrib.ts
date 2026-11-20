/**
 * GitLab as the review lane's forge (2026-08-20).
 *
 * Four verbs and nothing else: push a pipeline-owned branch, start its
 * pipeline, read a verdict, open/close a merge request. The token is the same
 * project access token `gitlab-ci.ts` already holds; it never leaves this
 * process and is never handed to an agent or a container. The branch push uses
 * the host's git remote exactly like `backUpBranch` does for the watermark.
 *
 * Everything here is a thin adapter. Policy — which branch, when to open the
 * MR, what a red means — lives in `contrib-review.ts`.
 */

import { createLogger } from "../logger.js";
import { digestCiTrace } from "./ci-trace-digest.js";
import { isInfrastructureFailure } from "./gitlab-ci.js";
import { git } from "./worktree.js";
import type {
  MergeRequestRef,
  PipelineVerdict,
  ProposalPublishInput,
  ProposalPublishResult,
  ProposalPublisher,
} from "./contrib-review.js";

const log = createLogger("gitlab-contrib");
const PUSH_TIMEOUT_MS = 60_000;
const API_TIMEOUT_MS = 15_000;
const TRACE_DIGEST_CHARS = 2_500;
/**
 * GitLab's own text limits: the Merge requests API takes a `description` of
 * at most 1,048,576 characters, the Notes API a `body` of at most 1,000,000,
 * and a merge request `title` of at most 255. Longer text continues in further
 * notes rather than being cut.
 */
export const GITLAB_MR_DESCRIPTION_MAX = 1_048_576;
export const GITLAB_NOTE_MAX = 1_000_000;
export const GITLAB_TITLE_MAX = 255;

/** `text` in pieces of at most `max` UTF-16 units, never splitting a surrogate pair. */
export function gitlabTextParts(text: string, max: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length && end > start + 1) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts.length ? parts : [""];
}

/** Room left in a piece for the continuation label GitLab readers see. */
const PART_LABEL_RESERVE = 200;

export interface GitLabContribOpts {
  /** Local repository whose remote the branch is pushed from. */
  repoDir: string;
  /** Git remote name; the pipeline's `pushRemote`, default `origin`. */
  remote?: string;
  apiUrl: string;
  project: string | number;
  token: string;
  fetchFn?: typeof fetch;
}

interface GitLabPipeline {
  id: number;
  iid: number;
  status: string;
  web_url: string;
}

interface GitLabJob {
  id: number;
  name: string;
  status: string;
  failure_reason?: string | null;
  web_url?: string;
}

interface GitLabMergeRequest {
  iid: number;
  web_url: string;
  state: string;
}

/** The predicate `.gitlab-ci.yml` keys the contributor job on. */
export const CONTRIB_PIPELINE_NAME = "octopus-contrib-check";

export class GitLabContribPublisher implements ProposalPublisher {
  private readonly repoDir: string;
  private readonly remote: string;
  private readonly apiUrl: string;
  private readonly project: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GitLabContribOpts) {
    this.repoDir = opts.repoDir;
    this.remote = opts.remote ?? "origin";
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.project = encodeURIComponent(String(opts.project));
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async publish(input: ProposalPublishInput): Promise<ProposalPublishResult> {
    // `+sha:refs/heads/<branch>` — a forced update of a pipeline-owned transfer
    // branch. It is rebased on every resubmit, so it is never a fast-forward of
    // itself, and nobody else may write it (the branch name says whose it is).
    const push = await git(
      this.repoDir,
      ["push", "--quiet", this.remote, `+${input.sha}:refs/heads/${input.branch}`],
      PUSH_TIMEOUT_MS,
    );
    if (!push.ok) throw new Error(`git push ${this.remote} ${input.branch} failed: ${push.stderr.slice(-400)}`);
    const pipeline = await this.api<GitLabPipeline>(`/projects/${this.project}/pipeline`, {
      method: "POST",
      body: { ref: input.branch },
    });
    log.info({ ticket: input.ticketId, branch: input.branch, pipeline: pipeline.id }, "contrib pipeline triggered");
    return { pipelineId: String(pipeline.id), pipelineUrl: pipeline.web_url };
  }

  async pipelineVerdict(pipelineId: string): Promise<PipelineVerdict> {
    const pipeline = await this.api<GitLabPipeline>(`/projects/${this.project}/pipelines/${encodeURIComponent(pipelineId)}`);
    if (pipeline.status === "success") return { status: "success" };
    if (pipeline.status === "failed") {
      const jobs = await this.api<GitLabJob[]>(`/projects/${this.project}/pipelines/${pipeline.id}/jobs?per_page=100`);
      const failed = jobs.filter((job) => job.status === "failed");
      if (failed.length > 0 && failed.every((job) => isInfrastructureFailure(job.failure_reason))) {
        return { status: "aborted", reason: failed.map((job) => job.failure_reason ?? "infrastructure").join(",") };
      }
      const lines: string[] = [`GitLab pipeline #${pipeline.iid} failed`, pipeline.web_url];
      for (const job of failed.slice(0, 3)) {
        lines.push(`- ${job.name}: ${job.failure_reason || "failed"}${job.web_url ? ` (${job.web_url})` : ""}`);
        try {
          const trace = await this.apiText(`/projects/${this.project}/jobs/${job.id}/trace`);
          const digest = digestCiTrace(trace, { maxChars: TRACE_DIGEST_CHARS });
          lines.push(`\n--- ${job.name} ${digest.structured ? "失败摘要" : "日志尾部"} ---\n${digest.text}`);
        } catch (err) {
          lines.push(`\n--- ${job.name} trace unavailable: ${String(err)} ---`);
        }
      }
      return { status: "failed", digest: lines.join("\n") };
    }
    if (["canceled", "skipped", "manual"].includes(pipeline.status)) {
      return { status: "aborted", reason: pipeline.status };
    }
    return { status: "running" };
  }

  async openMergeRequest(input: {
    branch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<MergeRequestRef | null> {
    // An MR for this branch may already exist from an earlier proposal of the
    // same ticket: GitLab follows the branch, so reuse it rather than 409.
    const existing = await this.api<GitLabMergeRequest[]>(
      `/projects/${this.project}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.branch)}`,
    );
    if (existing.length > 0) return { iid: existing[0].iid, url: existing[0].web_url };
    // A title over GitLab's limit is shortened visibly and stated whole in the description.
    const titleFits = input.title.length <= GITLAB_TITLE_MAX;
    const title = titleFits ? input.title : `${gitlabTextParts(input.title, GITLAB_TITLE_MAX - 1)[0]}…`;
    const text = titleFits ? input.description : `Full title: ${input.title}\n\n${input.description}`;
    const [head, ...rest] = text.length <= GITLAB_MR_DESCRIPTION_MAX
      ? [text]
      : gitlabTextParts(text, GITLAB_NOTE_MAX - PART_LABEL_RESERVE);
    const description = rest.length
      ? `${head}\n\n(Description continues in the next ${rest.length} comment(s) of this merge request; GitLab limits a description to ${GITLAB_MR_DESCRIPTION_MAX} characters.)`
      : head;
    const created = await this.api<GitLabMergeRequest>(`/projects/${this.project}/merge_requests`, {
      method: "POST",
      body: {
        source_branch: input.branch,
        target_branch: input.targetBranch,
        title,
        description,
        remove_source_branch: false,
        squash: false,
      },
    });
    for (const [index, part] of rest.entries()) {
      await this.postNote(created.iid, `(Description, continued ${index + 2}/${rest.length + 1})\n\n${part}`);
    }
    return { iid: created.iid, url: created.web_url };
  }

  async closeMergeRequest(iid: number, note: string): Promise<void> {
    const parts = gitlabTextParts(note, GITLAB_NOTE_MAX - PART_LABEL_RESERVE);
    try {
      for (const [index, part] of parts.entries()) {
        await this.postNote(iid, parts.length > 1 ? `(${index + 1}/${parts.length})\n\n${part}` : part);
      }
    } catch (err) {
      log.warn({ iid, err }, "merge request note failed");
    }
    await this.api(`/projects/${this.project}/merge_requests/${iid}`, {
      method: "PUT",
      body: { state_event: "close" },
    });
  }

  private async postNote(iid: number, body: string): Promise<void> {
    await this.api(`/projects/${this.project}/merge_requests/${iid}/notes`, { method: "POST", body: { body } });
  }

  private async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "PRIVATE-TOKEN": this.token,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitLab ${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  private async apiText(path: string): Promise<string> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      headers: { "PRIVATE-TOKEN": this.token },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitLab GET ${path} → HTTP ${res.status}`);
    return await res.text();
  }
}
