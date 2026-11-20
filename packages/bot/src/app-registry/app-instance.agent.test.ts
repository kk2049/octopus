/** Trusted vertical for `binding: agent`: a View proposal can enqueue only the
 * release-declared target, with owner/app supplied by the instance principal. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { AppInstanceService } from "./app-instance.js";

const manifest: SessionPlusManifest = {
  id: "deck-agent",
  schema: 2,
  stateScope: "account",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {},
  pageFile: "pages/main.yaml",
  agents: { maker: { name: "maker", adapter: "openai-loop", prompt: "make slides" } },
  actions: {
    ask: {
      binding: "agent",
      agent: "maker",
      humanOnly: true,
      agentOnly: false,
      params: { prompt: { type: "string", max: 2000, required: true } },
    },
    apply: { binding: "runtime", humanOnly: false, agentOnly: true, params: {} },
  },
};

class Runtime implements AppRuntimeClient {
  async project(_request: ProjectRequest): Promise<RuntimeJson> { return { deck: [] }; }
  async invoke(_request: InvokeRequest): Promise<InvokeResult> { return { events: [], result: null }; }
  async health() { return { ok: true, backendCodeDigest: "b".repeat(64) }; }
}

const release = {
  stableAppId: "deck-agent",
  publisher: "demo:test",
  packageDigest: "pkg-1",
  permissionContractDigest: "c".repeat(64),
  backendCodeDigest: "b".repeat(64),
  appDir: "/prepared/deck-agent",
};

const dirs: string[] = [];
const services: AppInstanceService[] = [];
const states: AppStateService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  for (const state of states.splice(0)) await state.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(deliverAgent?: ConstructorParameters<typeof AppInstanceService>[0]["deliverAgent"]) {
  const dir = mkdtempSync(join(tmpdir(), "app-agent-binding-"));
  dirs.push(dir);
  const state = new AppStateService(join(dir, "state"));
  states.push(state);
  const value = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime: new Runtime(),
    activeRelease: () => release,
    servableRelease: (digest) => digest === release.packageDigest ? release : null,
    servablePackageDigests: () => new Set([release.packageDigest]),
    loadManifest: () => manifest,
    deliverAgent,
  });
  services.push(value);
  return value;
}

describe("declared App agent binding", () => {
  it("derives target identity from the active release and user principal", async () => {
    const delivered: unknown[] = [];
    const app = service(async (input) => { delivered.push(input); return { ok: true, duplicate: false }; });
    const principal = { owner: "alice", credential: "web:a", session: true };
    const opened = await app.open(principal);
    const answer = await app.dispatch(opened.handle, principal, { action: "ask", params: { prompt: "做一份发布稿" } });
    expect(answer).toMatchObject({ ok: true, result: { queued: true, duplicate: false } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      appId: "deck-agent",
      owner: "alice",
      agent: "maker",
      text: "做一份发布稿",
    });
  });

  it("fails closed when this deployment disabled the agent plane", async () => {
    const app = service();
    const principal = { owner: "alice", credential: "web:a", session: true };
    const opened = await app.open(principal);
    expect(await app.dispatch(opened.handle, principal, { action: "ask", params: { prompt: "hi" } }))
      .toMatchObject({ ok: false, code: "not_supported" });
  });
});
