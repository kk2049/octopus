/** Same parsing and pipeline dispatch for the loopback and ticket-scoped MCP doors. */
import type { DevPipeline, TicketRetrievalFeedbackInput } from "./pipeline.js";
import { parseLandingKnowledge } from "./landing-knowledge.js";

export type DevpipeToolPort = Pick<DevPipeline, "toolCiJob" | "toolCiSync" | "toolSubmit" | "toolStatus" | "toolContext" | "toolConflictRead" | "toolConflictResolve" | "toolAppRelease" | "toolAppHotswap" | "toolAsk" | "toolRename"> & {
  /** Optional during rolling upgrade; its target is the trusted ticket binding. */
  toolSources?(token: string, input: Record<string,unknown>): Promise<unknown>;
  toolWorkspaceSync?(token: string): Promise<unknown>;
};

function answer(status: number, body: unknown): { status: number; body: unknown } {
  return { status, body };
}

/** The token is supplied by a trusted live-turn closure, never by tool arguments. */
export async function dispatchDevpipeTool(
  pipe: DevpipeToolPort, token: string, op: string, rawBody: unknown,
): Promise<{ status: number; body: unknown }> {
  // Ticket #16 retires 'claim' — parallel coding + serial merge means
  // there is nothing to claim before typing; submit is the whole merge
  // phase. A stray old MCP subprocess (from an in-flight turn straddling
  // the deploy) will hit here with op="claim" and get a clear 410.
  if (op === "claim") {
    return answer(410, {
      ok: false,
      code: "not_holder",
      message:
        "devpipe_claim_workspace 已被 ticket #16 移除:你在 worktree 里直接开发即可,合并锁由 devpipe_submit 自己抢。" +
        "如果你还看到 claim 工具,可能是老 MCP 子进程,直接跑 devpipe_submit。",
    });
  } else if (op === "workspace-sync") {
    return answer(200, pipe.toolWorkspaceSync
      ? await pipe.toolWorkspaceSync(token)
      : { ok: false, code: "unavailable", message: "本票开发工作区同步尚未组合" });
  } else if (op === "ci-job") {
    return answer(200, await pipe.toolCiJob(token, rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {}));
  } else if (op === "ci-sync") {
    return answer(200, await pipe.toolCiSync(token));
  } else if (op === "submit") {
    // The tests this turn NAMED, if any. A bad shape is treated as "none"
    // rather than refused: the tool's contract is that landing does not
    // depend on tests, so a malformed hint must not become a merge failure.
    const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
    const raw = body.tests;
    const tests = Array.isArray(raw)
      ? raw.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 200).slice(0, 12)
      : [];
    // Ticket #201: what the agent still needs from the requester, set with
    // the land. A bad shape is "no question"; knowledge is different:
    // malformed lifecycle evidence is a refusal, never silently discarded.
    const asked = body.open_question;
    let knowledge: ReturnType<typeof parseLandingKnowledge>;
    try {
      knowledge = parseLandingKnowledge(body.knowledge);
    } catch (error) {
      // Validation errors at this boundary are an ordinary tool refusal.
      // Letting them escape makes TicketDevelopmentRegistry classify a bad
      // submit payload as an indeterminate side effect, so the agent sees
      // only “unknown” and cannot correct the request.
      const message = error instanceof Error ? error.message : String(error);
      return answer(200, { ok: false, code: "invalid_params", message: `devpipe_submit 参数无效：${message}` });
    }
    const feedbackCodes: ReadonlyArray<TicketRetrievalFeedbackInput["code"]> = [
      "helpful", "not_helpful", "missing_slot", "code_index_stale",
      "vector_unavailable", "no_grounded_answer", "wrong_lifecycle", "wrong_scope",
    ];
    const feedbackSlots: ReadonlyArray<NonNullable<TicketRetrievalFeedbackInput["slot"]>> = [
      "contract_principle", "scenarios", "sources_requirements", "decisions_exceptions",
      "actions_symbols", "tests_evidence", "landings_patterns", "unknown_conflicts",
    ];
    const rawFeedback = body.retrieval_feedback;
    const retrievalFeedback: TicketRetrievalFeedbackInput[] = Array.isArray(rawFeedback)
      ? rawFeedback.flatMap((rawItem) => {
          if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return [];
          const item = rawItem as Record<string, unknown>;
          if (typeof item.trace_id !== "string" || !/^kr_[0-9a-f]{32}$/u.test(item.trace_id)) return [];
          if (typeof item.code !== "string" || !feedbackCodes.includes(item.code as TicketRetrievalFeedbackInput["code"])) return [];
          if (item.slot !== undefined && (typeof item.slot !== "string" || !feedbackSlots.includes(item.slot as NonNullable<TicketRetrievalFeedbackInput["slot"]>))) return [];
          if (item.expected_record_id !== undefined
            && (typeof item.expected_record_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,511}$/u.test(item.expected_record_id))) return [];
          return [{
            trace_id: item.trace_id as TicketRetrievalFeedbackInput["trace_id"],
            code: item.code as TicketRetrievalFeedbackInput["code"],
            ...(item.slot ? { slot: item.slot as TicketRetrievalFeedbackInput["slot"] } : {}),
            ...(item.expected_record_id ? { expected_record_id: item.expected_record_id } : {}),
          }];
        }).slice(0, 8)
      : [];
    return answer(200, await pipe.toolSubmit(
      token,
      tests,
      typeof asked === "string" ? asked : undefined,
      knowledge,
      retrievalFeedback,
      body.delivery,
    ));
  } else if (op === "status") {
    return answer(200, await pipe.toolStatus(token));
  } else if (op === "sources") {
    const input = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody as Record<string,unknown> : {};
    return answer(200, pipe.toolSources ? await pipe.toolSources(token,input) : {ok:false,message:"当前服务尚不支持来源草稿"});
  } else if (op === "context") {
    // Read-only knowledge lookup for the live turn; a bad shape is an empty
    // path list, which the pipeline answers with a readable refusal.
    const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 300).slice(0, 40)
      : [];
    const question = typeof body.question === "string" ? body.question.slice(0, 300) : undefined;
    return answer(200, await pipe.toolContext(token, paths, question));
  } else if (op === "conflict-read") {
    return answer(200, await pipe.toolConflictRead(token));
  } else if (op === "conflict-resolve") {
    const body = rawBody;
    const note = body && typeof body === "object" && "note" in body ? body.note : undefined;
    return answer(200, await pipe.toolConflictResolve(token, typeof note === "string" ? note : undefined));
  } else if (op === "app-release") {
    // Ticket #61: publish an Agentic App's release from the ticket that
    // just changed it. The pipeline owns every decision (which app, which
    // checkout, whether it has to wait for a deploy); this only forwards
    // the optional name.
    const app = (rawBody as { app?: unknown } | undefined)?.app;
    return answer(200, await pipe.toolAppRelease(token, { app: typeof app === "string" ? app : undefined }));
  } else if (op === "app-hotswap") {
    // P5: the three values are assertions, not path/branch selectors. Keep
    // their raw types so the pipeline can distinguish a missing assertion
    // from a string that failed to match the trusted ticket closure.
    const body = rawBody as { app?: unknown; expected_commit?: unknown; source?: unknown } | undefined;
    return answer(200, await pipe.toolAppHotswap(token, {
      app: body?.app,
      expected_commit: body?.expected_commit,
      source: body?.source,
    }));
  } else if (op === "ask") {
    // Ticket #201: this turn is ending with something only the requester can
    // decide. The pipeline enforces the bound and owns the wording.
    const question = (rawBody as { question?: unknown } | undefined)?.question;
    return answer(200, await pipe.toolAsk(token, typeof question === "string" ? question : ""));
  } else if (op === "rename") {
    // Ticket #38-5: discuss-mode agent renames its own conversation.
    // toolRename itself rejects non-discuss tickets and enforces length
    // — no second copy of the rule here.
    const title = (rawBody as { title?: unknown } | undefined)?.title;
    const t = typeof title === "string" ? title : "";
    return answer(200, await pipe.toolRename(token, t));
  } else {
    return answer(404, { message: `未知操作: ${op}` });
  }
}

