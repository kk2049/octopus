/**
 * The remote `workspace-files/v1` client, against a transport that lies.
 *
 * The point of every case below is that the consumer does not have to trust the
 * other end. A frame can be edited, re-ordered, truncated or invented, a
 * `propose()` can reject instead of resolving, and an answer can be a perfectly
 * valid one for somewhere else. Each of those must produce ONE terminal refusal
 * and release the stream — never a short file that looks complete, and never an
 * exception a viewer would render with whatever the trusted side put in it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  RESOURCE_STREAM_CONTRACT,
  drainResourceStream,
  type ResourceStreamResponseFrame,
} from "@claude-bot/resource-stream-contract";
import {
  RESOURCE_ACTIONS,
  RESOURCE_PARAMS,
  WORKSPACE_FILES_PROPOSAL_ACTIONS,
  createRemoteWorkspaceFilesPort,
  readWorkspaceTextOpenPayload,
  type ProposalAnswer,
  type ProposalTransport,
} from "./remote.js";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_TEXT_CHUNK_PAYLOAD,
  WORKSPACE_TEXT_MEDIA_TYPE,
} from "./limits.js";
import { workspaceFilesCanWrite } from "./port.js";
import { utf8ByteLength } from "./projection.js";

const HANDLE = "rs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_HANDLE = "rs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = "wf_ref";

/**
 * One consistent file, as the header and the frames that carry it.
 *
 * The pieces have to AGREE — that is now most of what this client checks — so
 * they are derived from the text rather than written out twice.
 */
function fixture(parts: string[]) {
  const bytes = parts.reduce((total, part) => total + utf8ByteLength(part), 0);
  const document = {
    ref: REF,
    label: "a.ts",
    mediaType: WORKSPACE_TEXT_MEDIA_TYPE,
    sizeBytes: bytes,
    digest: DIGEST,
  };
  const metadata = {
    payload: WORKSPACE_TEXT_CHUNK_PAYLOAD,
    mediaType: WORKSPACE_TEXT_MEDIA_TYPE,
    totalBytes: bytes,
    digest: DIGEST,
  };
  const payload = {
    document,
    stream: { contract: RESOURCE_STREAM_CONTRACT, kind: "open", handle: HANDLE, metadata },
  };
  const frames: ResourceStreamResponseFrame[] = parts.map((part, index) => chunk(index, part));
  frames.push(end(parts.length, bytes));
  return { text: parts.join(""), bytes, document, metadata, payload, frames };
}

const FILE = fixture(["第一行\n", "abc"]);

function chunk(seq: number, text: string, bytes = utf8ByteLength(text)): ResourceStreamResponseFrame {
  return { contract: RESOURCE_STREAM_CONTRACT, kind: "chunk", handle: HANDLE, seq, bytes, value: { text } };
}

function end(chunks: number, bytes: number): ResourceStreamResponseFrame {
  return { contract: RESOURCE_STREAM_CONTRACT, kind: "end", handle: HANDLE, chunks, bytes };
}

interface Script {
  [action: string]: (params: Record<string, string>) => ProposalAnswer | Promise<ProposalAnswer>;
}

/** A transport that answers from a script and records every proposal. */
function scripted(script: Script): ProposalTransport & { sent: Array<{ action: string; params: Record<string, string> }> } {
  const sent: Array<{ action: string; params: Record<string, string> }> = [];
  return {
    sent,
    async propose(action, params = {}) {
      sent.push({ action, params });
      const handler = script[action];
      if (!handler) return { ok: false, code: "invalid_request", result: null, message: "无此动作" };
      return await handler(params);
    },
  };
}

/** Serve `frames` in order, on top of a working `open_text`. */
function pullScript(frames: ResourceStreamResponseFrame[], payload: unknown = FILE.payload): Script {
  let index = 0;
  return {
    [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result: payload, message: "" }),
    [RESOURCE_ACTIONS.streamPull]: () => ({ ok: true, result: frames[index++] ?? end(0, 0), message: "" }),
    [RESOURCE_ACTIONS.streamClose]: () => ({ ok: true, result: { closed: true }, message: "" }),
  };
}

async function openStream(script: Script) {
  const remote = createRemoteWorkspaceFilesPort(scripted(script), "workspace");
  const opened = await remote.port.openText(REF);
  if (!opened.ok) throw new Error(`expected open, got ${opened.code}`);
  return opened.value;
}

describe("the vocabulary", () => {
  it("prefixes its actions and states a closed set", () => {
    // Four contract verbs plus the two stream verbs. All six travel this wire
    // since the editor batch raised the bound for the write's one large
    // parameter.
    expect(WORKSPACE_FILES_PROPOSAL_ACTIONS).toHaveLength(6);
    for (const action of WORKSPACE_FILES_PROPOSAL_ACTIONS) expect(action.startsWith("resource.")).toBe(true);
    // The contract is NOT in the action string: the dispatcher resolves it from
    // the App's plan, which is a document the View cannot edit.
    for (const action of WORKSPACE_FILES_PROPOSAL_ACTIONS) expect(action).not.toContain(WORKSPACE_FILES_CONTRACT);
  });
});

describe("what a module can say", () => {
  it("sends the binding and an opaque ref, and nothing else", async () => {
    const transport = scripted({
      [RESOURCE_ACTIONS.refreshRoots]: () => ({ ok: true, result: { roots: [], truncated: false }, message: "" }),
      [RESOURCE_ACTIONS.listDirectory]: () => ({
        ok: true,
        result: { ref: "wf_dir", label: "demo", entries: [], truncated: false },
        message: "",
      }),
    });
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");

    expect((await remote.port.refreshRoots()).ok).toBe(true);
    expect((await remote.port.listDirectory("wf_dir")).ok).toBe(true);

    expect(transport.sent[0]).toEqual({
      action: RESOURCE_ACTIONS.refreshRoots,
      params: { [RESOURCE_PARAMS.binding]: "workspace" },
    });
    expect(transport.sent[1]).toEqual({
      action: RESOURCE_ACTIONS.listDirectory,
      params: { [RESOURCE_PARAMS.binding]: "workspace", [RESOURCE_PARAMS.ref]: "wf_dir" },
    });
    // No owner, no app, no scope, no instance, no device, no path: not filtered,
    // absent — there is no code here that could send one.
    const wire = JSON.stringify(transport.sent);
    for (const forbidden of ["owner", "app", "scope", "instance", "device", "path", "workspace_id"]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });

  it("has four methods and no way to name an action", () => {
    const remote = createRemoteWorkspaceFilesPort(scripted({}), "workspace");
    expect(Object.keys(remote.port).sort()).toEqual([
      "contract",
      "listDirectory",
      "openText",
      "refreshRoots",
      "replaceText",
    ]);
    expect(remote.port.contract).toBe(WORKSPACE_FILES_CONTRACT);
    // The predicate a consumer reads before rendering a save control. It says
    // the TRANSPORT can carry a write, not that this scope may perform one.
    expect(workspaceFilesCanWrite(remote.port)).toBe(true);
  });
});

describe("submitting a replacement", () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    ref: REF,
    mutationId: "0123456789abcdef",
    operation: "replace_text",
    beforeDigest: DIGEST,
    afterDigest: `sha256:${"b".repeat(64)}`,
    sizeBytes: 5,
    committedAt: "2026-08-07T12:34:56.000Z",
    undo: "unsupported",
    ...overrides,
  });

  function writeScript(answer: (params: Record<string, string>) => ProposalAnswer): Script {
    return { [RESOURCE_ACTIONS.replaceText]: answer };
  }

  it("sends the binding, the ref, the precondition and the body — and nothing else", async () => {
    const transport = scripted(writeScript(() => ({ ok: true, result: receipt(), message: "" })));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const saved = await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text: "hello" });

    expect(saved.ok).toBe(true);
    expect(transport.sent).toEqual([
      {
        action: RESOURCE_ACTIONS.replaceText,
        params: {
          [RESOURCE_PARAMS.binding]: "workspace",
          [RESOURCE_PARAMS.ref]: REF,
          [RESOURCE_PARAMS.expectedDigest]: DIGEST,
          [RESOURCE_PARAMS.text]: "hello",
        },
      },
    ]);
    const wire = JSON.stringify(transport.sent);
    for (const forbidden of ["owner", "app", "scope", "instance", "device", "path", "workspace_id"]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });

  it("carries a body far larger than one ordinary parameter", async () => {
    // The whole point of the wire ruling. 512 characters was the old bound for
    // every parameter; this one is a file.
    const text = "x".repeat(200_000);
    const transport = scripted(writeScript(() => ({ ok: true, result: receipt(), message: "" })));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    expect((await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text })).ok).toBe(true);
    expect(transport.sent[0]!.params[RESOURCE_PARAMS.text]).toHaveLength(200_000);
  });

  /**
   * A provider that stages: begin mints a token, each append must land at the
   * staged size, commit answers the receipt for the bytes it holds.
   */
  function stagingScript(overrides: { commit?: (size: number) => ProposalAnswer } = {}): Script {
    const token = "0123456789abcdef0123456789abcdef";
    let body = "";
    return {
      // Not an action: a test-only window onto what was staged.
      staged: () => ({ ok: true, result: body, message: "" }),
      [RESOURCE_ACTIONS.replaceText]: (params) => {
        if (params.stage === "begin") return { ok: true, result: { upload: token, sizeBytes: 0 }, message: "" };
        if (params.stage === "append") {
          if (params.upload !== token || Number(params.offset) !== utf8ByteLength(body)) {
            return { ok: false, code: "unavailable", result: null, message: "offset" };
          }
          body += params.text;
          return { ok: true, result: { upload: token, sizeBytes: utf8ByteLength(body) }, message: "" };
        }
        if (params.stage === "commit") {
          if (overrides.commit) return overrides.commit(Number(params.size));
          return { ok: true, result: receipt({ sizeBytes: Number(params.size) }), message: "" };
        }
        return { ok: false, code: "invalid_request", result: null, message: "whole" };
      },
    };
  }

  it("saves a body over one window as one staged upload, never refusing it for size", async () => {
    // 2026-10-20: the per-call bound is a window, not the file size. A body
    // past it is cut on character boundaries and committed once.
    const script = stagingScript();
    const transport = scripted(script);
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const text = "汉字x".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes / 2);
    const out = await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text });
    expect(out).toMatchObject({ ok: true, value: { sizeBytes: utf8ByteLength(text) } });
    expect((script.staged!({}) as ProposalAnswer).result).toBe(text);
    const stages = transport.sent.map((row) => row.params.stage);
    expect(stages[0]).toBe("begin");
    expect(stages.at(-1)).toBe("commit");
    expect(stages.slice(1, -1).every((stage) => stage === "append")).toBe(true);
    for (const row of transport.sent) {
      // Each call stays inside the one raised parameter's bound.
      expect(utf8ByteLength(row.params.text ?? "")).toBeLessThanOrEqual(WORKSPACE_FILES_LIMITS.maxWriteTextBytes);
      // No staged step can be read by an older Host as a one-call replace: the
      // begin and commit carry no body, an append no precondition.
      if (row.params.stage === "append") expect(row.params.expected_digest).toBeUndefined();
      else expect(row.params.text).toBeUndefined();
    }
    expect(transport.sent.at(-1)!.params).toMatchObject({ expected_digest: DIGEST, size: String(utf8ByteLength(text)) });
  });

  it("ends a staged save at the first refusal, and accepts no receipt for other bytes", async () => {
    const refusing = scripted(stagingScript({
      commit: () => ({ ok: false, code: "digest_mismatch", result: null, message: "changed" }),
    }));
    const text = "y".repeat(WORKSPACE_FILES_LIMITS.maxWriteTextBytes * 2);
    expect(await createRemoteWorkspaceFilesPort(refusing, "workspace").port.replaceText!(REF, {
      expectedDigest: DIGEST,
      text,
    })).toMatchObject({ ok: false, code: "digest_mismatch" });

    const lying = scripted(stagingScript({
      commit: (size) => ({ ok: true, result: receipt({ sizeBytes: size - 1 }), message: "" }),
    }));
    expect(await createRemoteWorkspaceFilesPort(lying, "workspace").port.replaceText!(REF, {
      expectedDigest: DIGEST,
      text,
    })).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a malformed precondition locally, and proposes nothing", async () => {
    const transport = scripted(writeScript(() => ({ ok: true, result: receipt(), message: "" })));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const out = await remote.port.replaceText!(REF, { expectedDigest: "not-a-digest", text: "hi" });
    expect(out).toMatchObject({ ok: false, code: "invalid_request" });
    expect(transport.sent).toEqual([]);
  });

  it("passes a needs-approval answer through as itself", async () => {
    // The normal outcome of a write, not a failure: a person has to press a
    // button, and the result comes back to them.
    const transport = scripted(
      writeScript(() => ({ ok: false, code: "approval_required", result: null, message: "需要批准" })),
    );
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    expect(await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text: "hi" })).toMatchObject({
      ok: false,
      code: "approval_required",
      message: "需要批准",
    });
  });

  it("passes digest_mismatch and read_only through as themselves", async () => {
    for (const code of ["digest_mismatch", "read_only"] as const) {
      const remote = createRemoteWorkspaceFilesPort(
        scripted(writeScript(() => ({ ok: false, code, result: null, message: "no" }))),
        "workspace",
      );
      expect(await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text: "hi" })).toMatchObject({
        ok: false,
        code,
      });
    }
  });

  it("refuses a receipt about another file or another precondition", async () => {
    // A receipt is what a person reads as "saved". One describing a different
    // file, or a different base version, would be a success message about
    // somebody else's write.
    for (const wrong of [{ ref: "wf_other" }, { beforeDigest: `sha256:${"c".repeat(64)}` }]) {
      const remote = createRemoteWorkspaceFilesPort(
        scripted(writeScript(() => ({ ok: true, result: receipt(wrong), message: "" }))),
        "workspace",
      );
      expect(await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text: "hi" })).toMatchObject({
        ok: false,
        code: "unavailable",
      });
    }
  });

  it("refuses a receipt that carries a field this contract does not project", async () => {
    const remote = createRemoteWorkspaceFilesPort(
      scripted(writeScript(() => ({ ok: true, result: receipt({ path: "/home/u/p/a.ts" }), message: "" }))),
      "workspace",
    );
    expect(await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text: "hi" })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("answers scope_closed after destroy, and sends nothing", async () => {
    const transport = scripted(writeScript(() => ({ ok: true, result: receipt(), message: "" })));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    remote.destroy();
    expect(await remote.port.replaceText!(REF, { expectedDigest: DIGEST, text: "hi" })).toMatchObject({
      ok: false,
      code: "scope_closed",
    });
    expect(transport.sent).toEqual([]);
  });
});

describe("every method resolves", () => {
  it("turns every transport refusal into a bounded domain refusal", async () => {
    const remote = createRemoteWorkspaceFilesPort(
      scripted({
        [RESOURCE_ACTIONS.refreshRoots]: () => ({ ok: false, code: "no_authority", result: null, message: "没有权限" }),
        [RESOURCE_ACTIONS.listDirectory]: () => ({ ok: false, code: "unknown_ref", result: null, message: "不属于本视图" }),
        // A code this build does not know must not be rendered as if it meant
        // something.
        [RESOURCE_ACTIONS.openText]: () => ({ ok: false, code: "channel_closed", result: null, message: "通道已关闭" }),
      }),
      "workspace",
    );

    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "no_authority" });
    expect(await remote.port.listDirectory("wf_x")).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(await remote.port.openText("wf_x")).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("turns a REJECTING transport into a refusal, not an exception", async () => {
    // `propose()` is declared to resolve, but this side consumes somebody else's
    // implementation of it — and a rejection is also where a stack trace lives.
    const rejecting: ProposalTransport = { propose: () => Promise.reject(new Error("/home/alice/.ssh/id_rsa")) };
    const remote = createRemoteWorkspaceFilesPort(rejecting, "workspace");

    for (const answer of [
      await remote.port.refreshRoots(),
      await remote.port.listDirectory("wf_x"),
      await remote.port.openText("wf_x"),
    ]) {
      expect(answer).toMatchObject({ ok: false, code: "unavailable" });
      expect(JSON.stringify(answer)).not.toContain("id_rsa");
    }
  });

  it("terminates a stream when the transport starts rejecting mid-read", async () => {
    let calls = 0;
    const opened = await openStream({
      [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result: FILE.payload, message: "" }),
      [RESOURCE_ACTIONS.streamPull]: () => {
        calls += 1;
        if (calls === 1) return { ok: true, result: FILE.frames[0], message: "" };
        return Promise.reject(new Error("socket died"));
      },
      [RESOURCE_ACTIONS.streamClose]: () => ({ ok: true, result: {}, message: "" }),
    });

    expect(await opened.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "unavailable" });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
  });

  it("refuses an answer that is not even an object", async () => {
    const nonsense: ProposalTransport = { propose: async () => undefined as unknown as ProposalAnswer };
    const remote = createRemoteWorkspaceFilesPort(nonsense, "workspace");
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses an answer whose envelope fields have the wrong runtime types", async () => {
    for (const malformed of [
      { ok: "yes", result: { roots: [], truncated: false }, message: "" },
      { ok: false, code: "no_authority", result: null, message: 42 },
      { ok: false, code: 7, result: null, message: "no" },
    ]) {
      const transport: ProposalTransport = {
        propose: async () => malformed as unknown as ProposalAnswer,
      };
      const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
      await expect(remote.port.refreshRoots()).resolves.toMatchObject({ ok: false, code: "unavailable" });
    }
  });

  it("refuses an answer that does not survive the contract reader", async () => {
    const remote = createRemoteWorkspaceFilesPort(
      scripted({
        // An extra field is a refusal, not something to ignore.
        [RESOURCE_ACTIONS.refreshRoots]: () => ({
          ok: true,
          result: { roots: [{ ref: "wf_a", label: "x", sourceLabel: "y", device: "laptop" }], truncated: false },
          message: "",
        }),
        [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result: { document: FILE.document }, message: "" }),
      }),
      "workspace",
    );

    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "unavailable" });
    expect(await remote.port.openText(REF)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("never throws, whatever the payload is", async () => {
    for (const result of [null, 42, "text", [], { document: null }]) {
      const remote = createRemoteWorkspaceFilesPort(
        scripted({ [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result, message: "" }) }),
        "workspace",
      );
      await expect(remote.port.openText("wf_x")).resolves.toMatchObject({ ok: false });
    }
  });
});

describe("an answer must be for the thing that was asked", () => {
  it("refuses a listing that echoes a different ref", async () => {
    // Valid for somewhere else: the reader cannot catch this, and a consumer
    // keys its tree on `ref`, so accepting it would silently reparent a subtree.
    const remote = createRemoteWorkspaceFilesPort(
      scripted({
        [RESOURCE_ACTIONS.listDirectory]: () => ({
          ok: true,
          result: { ref: "wf_elsewhere", label: "demo", entries: [], truncated: false },
          message: "",
        }),
      }),
      "workspace",
    );
    expect(await remote.port.listDirectory("wf_asked")).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses an open whose document names a different ref", async () => {
    const remote = createRemoteWorkspaceFilesPort(
      scripted({ [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result: FILE.payload, message: "" }) }),
      "workspace",
    );
    expect(await remote.port.openText("wf_a_different_file")).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("reading a file over the transport", () => {
  it("drains in order and reassembles exactly", async () => {
    const transport = scripted(pullScript(FILE.frames));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const opened = await remote.port.openText(REF);

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.document.digest).toBe(DIGEST);
    const drained = await drainResourceStream(opened.value.stream);
    expect(drained.chunks.map((row) => row.text).join("")).toBe(FILE.text);
    expect(drained.seqs).toEqual([0, 1]);
    expect(drained.terminal.kind).toBe("end");
    // The pull frames stated the sequence they expected, so a producer can
    // refuse a pull that does not match its own cursor.
    const pulls = transport.sent.filter((row) => row.action === RESOURCE_ACTIONS.streamPull);
    expect(pulls.map((row) => row.params[RESOURCE_PARAMS.seq])).toEqual(["0", "1", "2"]);
  });

  it("streams an empty file as an empty stream", async () => {
    const empty = fixture([]);
    const opened = await openStream(pullScript(empty.frames, empty.payload));
    expect(await opened.stream.next()).toMatchObject({ kind: "end", chunks: 0, bytes: 0 });
  });

  it("terminates once on a sequence that does not match", async () => {
    const opened = await openStream(pullScript([chunk(0, "第一行\n"), chunk(7, "abc")]));

    expect(await opened.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
  });

  it("refuses a chunk whose stated bytes disagree with its own text", async () => {
    // Under-reporting is the interesting direction: believed, it would let a
    // stream carry more than its cap while the accounting said otherwise.
    const big = fixture(["x".repeat(1000)]);
    const opened = await openStream(pullScript([chunk(0, "x".repeat(1000), 1)], big.payload));

    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
  });

  it("refuses a chunk past the single-chunk ceiling", async () => {
    const huge = "x".repeat(WORKSPACE_FILES_LIMITS.textChunkBytes + 1);
    const opened = await openStream(pullScript([chunk(0, huge)], fixture([huge]).payload));

    const read = await opened.stream.next();
    expect(read.kind).toBe("refused");
    if (read.kind !== "refused") return;
    // Either bound is a correct answer; what must never happen is acceptance.
    expect(["too_large", "protocol"]).toContain(read.code);
  });

  it("refuses a frame for another stream, and a malformed one", async () => {
    const foreign: ResourceStreamResponseFrame = { ...chunk(0, "第一行\n"), handle: OTHER_HANDLE };
    const alien = await openStream(pullScript([foreign]));
    expect(await alien.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });

    const garbage = await openStream({
      [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result: FILE.payload, message: "" }),
      [RESOURCE_ACTIONS.streamPull]: () => ({ ok: true, result: { hello: "world" }, message: "" }),
      [RESOURCE_ACTIONS.streamClose]: () => ({ ok: true, result: {}, message: "" }),
    });
    expect(await garbage.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
  });

  it("maps a mid-stream transport refusal into the stream's own vocabulary", async () => {
    const opened = await openStream({
      [RESOURCE_ACTIONS.openText]: () => ({ ok: true, result: FILE.payload, message: "" }),
      [RESOURCE_ACTIONS.streamPull]: () => ({ ok: false, code: "scope_closed", result: null, message: "会话结束" }),
      [RESOURCE_ACTIONS.streamClose]: () => ({ ok: true, result: {}, message: "" }),
    });

    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "expired" });
  });

  it("does not pull again after a terminal, and closes the remote stream once", async () => {
    const transport = scripted(pullScript(FILE.frames));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const opened = await remote.port.openText(REF);
    if (!opened.ok) throw new Error("expected open");

    await drainResourceStream(opened.value.stream);
    const pullsAfterDrain = transport.sent.filter((row) => row.action === RESOURCE_ACTIONS.streamPull).length;
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    await opened.value.stream.close();
    await opened.value.stream.close();

    expect(transport.sent.filter((row) => row.action === RESOURCE_ACTIONS.streamPull)).toHaveLength(pullsAfterDrain);
    expect(transport.sent.filter((row) => row.action === RESOURCE_ACTIONS.streamClose)).toHaveLength(1);
  });

  it("closes an early-abandoned stream and stops touching the transport", async () => {
    const transport = scripted(pullScript(FILE.frames));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const opened = await remote.port.openText(REF);
    if (!opened.ok) throw new Error("expected open");

    expect(await opened.value.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    await opened.value.stream.close();
    const after = transport.sent.length;
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(transport.sent).toHaveLength(after);
  });
});

describe("an end is only an end if it agrees with what arrived", () => {
  it("refuses an end that claims more chunks than were delivered", async () => {
    const opened = await openStream(pullScript([FILE.frames[0], end(2, FILE.bytes)]));

    expect(await opened.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
  });

  it("refuses an end that claims a different byte count", async () => {
    const opened = await openStream(pullScript([FILE.frames[0], FILE.frames[1], end(2, FILE.bytes + 1)]));

    await opened.stream.next();
    await opened.stream.next();
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
  });

  it("refuses an end before the declared totalBytes — a transport-level early EOF", async () => {
    // Self-consistent and still a lie: one real chunk, then an `end` whose
    // counts match what arrived. Only the header's `totalBytes` can catch it,
    // which is why the open payload must agree with the document.
    const transport = scripted(pullScript([FILE.frames[0], end(1, utf8ByteLength("第一行\n"))]));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const opened = await remote.port.openText(REF);
    if (!opened.ok) throw new Error("expected open");

    expect(await opened.value.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
    // Terminal once, and the remote stream released once.
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(transport.sent.filter((row) => row.action === RESOURCE_ACTIONS.streamClose)).toHaveLength(1);
  });

  it("refuses a chunk that would carry more than the file declares", async () => {
    const opened = await openStream(pullScript([chunk(0, "第一行\n"), chunk(1, "abcdefghij")]));

    expect(await opened.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "protocol" });
  });
});

describe("destroy", () => {
  it("closes every live stream and refuses afterwards", async () => {
    const transport = scripted(pullScript(FILE.frames));
    const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
    const opened = await remote.port.openText(REF);
    if (!opened.ok) throw new Error("expected open");

    remote.destroy();
    remote.destroy(); // idempotent

    // The refusal is immediate — the guard is marked finished synchronously —
    // while the outbound close frame is best effort on the next microtask.
    expect(await opened.value.stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(transport.sent.filter((row) => row.action === RESOURCE_ACTIONS.streamClose)).toHaveLength(1);
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "scope_closed" });
    expect(await remote.port.openText(REF)).toMatchObject({ ok: false, code: "scope_closed" });
  });

  it("hands back nothing from a call that was already in flight", async () => {
    // The teardown race, once per method: a panel that unmounted mid-request
    // must not receive the answer a moment later.
    const answers: Record<string, unknown> = {
      [RESOURCE_ACTIONS.refreshRoots]: { roots: [], truncated: false },
      [RESOURCE_ACTIONS.listDirectory]: { ref: REF, label: "demo", entries: [], truncated: false },
      [RESOURCE_ACTIONS.openText]: FILE.payload,
    };
    for (const action of Object.keys(answers)) {
      let release: (() => void) | null = null;
      const transport: ProposalTransport = {
        propose: (asked) =>
          new Promise<ProposalAnswer>((resolve) => {
            release = () => resolve({ ok: true, result: answers[asked], message: "" });
          }),
      };
      const remote = createRemoteWorkspaceFilesPort(transport, "workspace");
      const pending =
        action === RESOURCE_ACTIONS.refreshRoots
          ? remote.port.refreshRoots()
          : action === RESOURCE_ACTIONS.listDirectory
            ? remote.port.listDirectory(REF)
            : remote.port.openText(REF);
      remote.destroy();
      release!();

      expect(await pending, `${action} answered after destroy`).toMatchObject({ ok: false, code: "scope_closed" });
    }
  });
});

describe("the open payload reader", () => {
  it("accepts the documented shape and refuses everything near it", () => {
    expect(readWorkspaceTextOpenPayload(FILE.payload).ok).toBe(true);
    expect(readWorkspaceTextOpenPayload({ ...FILE.payload, extra: 1 }).ok).toBe(false);
    expect(readWorkspaceTextOpenPayload({
      ...FILE.payload,
      stream: { ...FILE.payload.stream, kind: "chunk" },
    }).ok).toBe(false);
    expect(readWorkspaceTextOpenPayload({
      ...FILE.payload,
      stream: { ...FILE.payload.stream, handle: "no" },
    }).ok).toBe(false);
  });

  it("refuses a header and a stream that describe different things", () => {
    const cases: Array<[string, unknown]> = [
      ["payload id", { ...FILE.metadata, payload: "some-other/v1#chunk" }],
      ["media type", { ...FILE.metadata, mediaType: "text/markdown" }],
      ["total bytes", { ...FILE.metadata, totalBytes: FILE.bytes + 1 }],
      ["digest", { ...FILE.metadata, digest: `sha256:${"b".repeat(64)}` }],
      ["absent total bytes", { payload: FILE.metadata.payload, mediaType: FILE.metadata.mediaType, digest: DIGEST }],
      ["absent digest", { payload: FILE.metadata.payload, mediaType: FILE.metadata.mediaType, totalBytes: FILE.bytes }],
    ];
    for (const [why, metadata] of cases) {
      const read = readWorkspaceTextOpenPayload({
        ...FILE.payload,
        stream: { ...FILE.payload.stream, metadata },
      });
      expect(read.ok, `accepted a mismatched ${why}`).toBe(false);
    }

    // And the document itself must be the media type this contract states.
    expect(readWorkspaceTextOpenPayload({
      document: { ...FILE.document, mediaType: "text/markdown" },
      stream: { ...FILE.payload.stream, metadata: { ...FILE.metadata, mediaType: "text/markdown" } },
    }).ok).toBe(false);
  });
});

describe("a channel that is simply gone", () => {
  it("answers rather than hanging", async () => {
    const dead: ProposalTransport = {
      propose: vi.fn(async () => ({ ok: false, code: "no_channel", result: null, message: "可信外层还没有转交通道" })),
    };
    const remote = createRemoteWorkspaceFilesPort(dead, "workspace");
    expect(await remote.port.refreshRoots()).toMatchObject({ ok: false, code: "unavailable" });
    expect(await remote.port.openText("wf_x")).toMatchObject({ ok: false, code: "unavailable" });
  });
});
