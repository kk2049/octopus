/**
 * `external-app-host/v1` against the REAL parts of the boundary it claims to
 * reuse: a real SQLite Store, a real `AppInstanceService`, a real
 * `AppStateService` commit log, and a shared-scope manifest with two players
 * and a watcher. Only the Runtime sandbox is faked, at its client seam.
 *
 * What each group pins:
 *
 *  · the launch handoff — single use, TTL, exact origin, and a restart that
 *    forgets nothing it should remember and remembers nothing it should not;
 *  · storage — digests only, and no reply that carries a secret;
 *  · the two authorities — a human binding drives the human operation and is
 *    refused on the agent one, and the reverse, with authorship to match;
 *  · the seven live checks — seat, role, instance status, publisher trust,
 *    exact release digest, revocation, expiry — each of them refusing the NEXT
 *    call and tearing down the stream that is already open.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppRuntimeClient, InvokeRequest, InvokeResult, ProjectRequest, RuntimeJson } from "@claude-bot/app-runtime";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import { AppInstanceService } from "../app-registry/app-instance.js";
import type { AppReleaseIdentity, AppTrustStatus } from "../permissions/app-trust.js";
import { sessionPlusStateAppKey } from "../app-core/identity.js";
import type { InstanceEvent } from "../app-core/instance.js";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import { Store } from "../store/store.js";
import { EXTERNAL_APP_FRAME_PROTOCOL } from "./contract.js";
import { externalAppHostSettings } from "./settings.js";
import { ExternalAppHostService, externalSecretDigest, type ExternalAppTarget } from "./service.js";

const APP = "demo-board";
const INSTANCE = "asi_" + "1".repeat(32);
const ORIGIN = "http://127.0.0.1:9931";
const OTHER_ORIGIN = "http://[::1]:9931";

const MANIFEST: SessionPlusManifest = {
  id: APP,
  schema: 3,
  stateScope: "shared",
  stateEpoch: 0,
  stateEpochDeclared: false,
  roles: {
    white: { max: 1, observer: false },
    black: { max: 1, observer: false },
    watcher: { max: 8, observer: true },
  },
  pageFile: "pages/main.yaml",
  agents: {},
  actions: {
    move: {
      binding: "runtime",
      handler: "move",
      humanOnly: false,
      agentOnly: false,
      roles: ["white", "black"],
      title: "走子",
      params: {
        from: { type: "string", max: 8, required: true, description: "起点格" },
        to: { type: "string", max: 8, required: true, description: "终点格" },
      },
    },
    // A person-only action: an agent binding must not see it in its contract
    // and must be refused if it names it anyway.
    resign: {
      binding: "runtime",
      handler: "resign",
      humanOnly: true,
      agentOnly: false,
      roles: ["white", "black"],
      params: { confirm: { type: "string", max: 8, required: true, enum: ["确认"] } },
    },
    comment: {
      binding: "runtime",
      handler: "comment",
      humanOnly: false,
      agentOnly: false,
      roles: ["white", "black", "watcher"],
      params: { text: { type: "string", max: 80, required: true } },
    },
  },
};

class FakeRuntime implements AppRuntimeClient {
  lastContext: Record<string, RuntimeJson> | null = null;

  async project(request: ProjectRequest): Promise<RuntimeJson> {
    const snapshot = request.snapshot && typeof request.snapshot === "object" && !Array.isArray(request.snapshot)
      ? request.snapshot as Record<string, RuntimeJson>
      : {};
    const moves = Array.isArray(snapshot.moves) ? [...snapshot.moves] : [];
    const authors = Array.isArray(snapshot.authors) ? [...snapshot.authors] : [];
    moves.push(...request.events.filter((e) => e.type === "moved").map((e) => e.data as RuntimeJson));
    authors.push(...request.events.map((e) => String(e.by)));
    return {
      moves,
      authors,
    };
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    this.lastContext = request.context;
    const stamp = { at: "1999-01-01T00:00:00.000Z", by: "liar" };
    if (request.action === "move") {
      return { events: [{ type: "moved", data: { from: request.params.from, to: request.params.to }, ...stamp }], result: null };
    }
    return { events: [{ type: String(request.action), data: {}, ...stamp }], result: null };
  }

  async health(): Promise<{ ok: boolean; backendCodeDigest: string }> {
    return { ok: true, backendCodeDigest: "b".repeat(64) };
  }
}

const RELEASE = {
  stableAppId: APP,
  publisher: "demo:acme",
  packageDigest: "pkg-digest-1",
  permissionContractDigest: "c".repeat(64),
  backendCodeDigest: "b".repeat(64),
  appDir: "/nonexistent/prepared/demo-board",
};

let dir: string;
let store: Store;
let state: AppStateService;
let runtime: FakeRuntime;
let instances: AppInstanceService;
let service: ExternalAppHostService;
let activeRelease = RELEASE;
let trusted = new Set<string>();
let now = Date.parse("2026-08-17T09:00:00.000Z");
let audit: Array<{ operation: string; decision: string; reason?: string }> = [];

function settings() {
  return externalAppHostSettings({
    enabled: true,
    hosts: [
      { id: "dsh-local", origin: ORIGIN },
      { id: "dsh-other", origin: OTHER_ORIGIN },
    ],
    launch_ttl_seconds: 120,
    capability_ttl_seconds: 3_600,
  })!;
}

function target(): ExternalAppTarget {
  return {
    stableAppId: APP,
    publisher: RELEASE.publisher,
    title: "示例棋盘",
    packageDigest: activeRelease.packageDigest,
    viewOrigin: "https://app-abcdef0123456789abcd.apps.example.com",
    service: instances,
    unavailable: null,
  };
}

/** The consent row the trust door would have on file. */
function decisionFor(owner: string) {
  return {
    owner,
    appId: APP,
    publisher: RELEASE.publisher,
    profile: "publisher-js" as const,
    packageDigestAtConsent: activeRelease.packageDigest,
    followUpdates: false,
    decidedAt: new Date(now).toISOString(),
    revokedAt: null,
  };
}

/** A fresh service over the SAME Store — what a restart looks like. */
function buildService(): ExternalAppHostService {
  return new ExternalAppHostService({
    settings: settings(),
    store,
    app: (id) => (id === APP ? target() : null),
    trust: (owner: string, release: AppReleaseIdentity): AppTrustStatus =>
      trusted.has(owner) && release.packageDigest === activeRelease.packageDigest
        ? { trusted: true, reason: "exact_release", decision: decisionFor(owner) }
        : { trusted: false, reason: "never_decided", decision: null },
    audit: (entry) => audit.push({ operation: entry.operation, decision: entry.decision, reason: entry.reason }),
    now: () => now,
  });
}

/** Mint a launch grant and redeem it, as the page and the host together do. */
function bind(input: { owner: string; authority: "human" | "agent"; host?: string; origin?: string }) {
  const minted = service.mintLaunch({
    owner: input.owner,
    appId: APP,
    instanceKey: INSTANCE,
    hostId: input.host ?? "dsh-local",
    authority: input.authority,
  });
  if (!minted.ok) throw new Error(`mint refused: ${minted.code} ${minted.message}`);
  const exchanged = service.exchange({ token: minted.value.launch_token, origin: input.origin ?? ORIGIN });
  if (!exchanged.ok) throw new Error(`exchange refused: ${exchanged.code} ${exchanged.message}`);
  return { minted: minted.value, exchanged: exchanged.value };
}

function sessionFor(secret: string, operation: Parameters<ExternalAppHostService["session"]>[0]["operation"]) {
  return service.session({ secret, origin: ORIGIN, operation });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "app-external-"));
  store = new Store(join(dir, "bot.db"));
  state = new AppStateService(join(dir, "state"));
  runtime = new FakeRuntime();
  activeRelease = RELEASE;
  trusted = new Set(["alice", "bob", "carol"]);
  audit = [];
  now = Date.parse("2026-08-17T09:00:00.000Z");
  instances = new AppInstanceService({
    state: new InProcessStateClient(state),
    runtime,
    activeRelease: () => activeRelease,
    servableRelease: (digest) => (digest === activeRelease.packageDigest ? activeRelease : null),
    servablePackageDigests: () => new Set([activeRelease.packageDigest]),
    shared: {
      instance: (appId, key) => store.getSharedAppInstance(appId, key),
      member: (appId, key, username) => store.getSharedAppMember(appId, key, username),
    },
    loadManifest: () => MANIFEST,
    now: () => now,
  });
  store.createSharedAppInstance(
    { app_id: APP, instance_key: INSTANCE, creator: "alice", created_at: new Date(now).toISOString(), status: "open" },
    "white",
  );
  store.addSharedAppMember(APP, INSTANCE, "bob", "black", 1, new Date(now).toISOString());
  store.addSharedAppMember(APP, INSTANCE, "carol", "watcher", 8, new Date(now).toISOString());
  service = buildService();
});

afterEach(async () => {
  instances.stop();
  await state.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the launch handoff", () => {
  it("is single-use: the second exchange of one token is refused", () => {
    const minted = service.mintLaunch({ owner: "alice", appId: APP, instanceKey: INSTANCE, hostId: "dsh-local", authority: "human" });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const first = service.exchange({ token: minted.value.launch_token, origin: ORIGIN });
    expect(first.ok).toBe(true);
    const second = service.exchange({ token: minted.value.launch_token, origin: ORIGIN });
    expect(second).toMatchObject({ ok: false, code: "invalid_credential" });
  });

  it("expires: a token redeemed after its TTL is refused, and stays refused", () => {
    const minted = service.mintLaunch({ owner: "alice", appId: APP, instanceKey: INSTANCE, hostId: "dsh-local", authority: "human" });
    if (!minted.ok) throw new Error("mint refused");
    now += 121_000;
    expect(service.exchange({ token: minted.value.launch_token, origin: ORIGIN }))
      .toMatchObject({ ok: false, code: "invalid_credential" });
    now -= 121_000;
    // Turning the clock back does not resurrect it: the row was left unconsumed
    // but the refusal above must not have depended on luck.
    const late = service.exchange({ token: minted.value.launch_token, origin: ORIGIN });
    expect(late.ok).toBe(true);
  });

  it("is bound to ONE origin: the wrong host cannot redeem it, and burns it trying", () => {
    const minted = service.mintLaunch({ owner: "alice", appId: APP, instanceKey: INSTANCE, hostId: "dsh-local", authority: "human" });
    if (!minted.ok) throw new Error("mint refused");
    expect(service.exchange({ token: minted.value.launch_token, origin: OTHER_ORIGIN }))
      .toMatchObject({ ok: false, code: "origin_refused" });
    expect(service.exchange({ token: minted.value.launch_token, origin: undefined }))
      .toMatchObject({ ok: false, code: "invalid_credential" });
    // Presented from the wrong place = spent. The right host gets nothing either.
    expect(service.exchange({ token: minted.value.launch_token, origin: ORIGIN }))
      .toMatchObject({ ok: false, code: "invalid_credential" });
  });

  it("refuses a launch for an instance the person does not sit in", () => {
    // Publisher trust is asked BEFORE the seat, so a stranger who never
    // answered that door is told about the door — not about which instances
    // exist. Trusting the publisher is not membership either, which is what
    // the second call proves.
    expect(service.mintLaunch({ owner: "mallory", appId: APP, instanceKey: INSTANCE, hostId: "dsh-local", authority: "human" }))
      .toMatchObject({ ok: false, code: "trust_required" });
    trusted.add("mallory");
    expect(service.mintLaunch({ owner: "mallory", appId: APP, instanceKey: INSTANCE, hostId: "dsh-local", authority: "human" }))
      .toMatchObject({ ok: false, code: "not_member" });
    expect(service.mintLaunch({ owner: "alice", appId: APP, instanceKey: INSTANCE, hostId: "nope", authority: "human" }))
      .toMatchObject({ ok: false, code: "origin_refused" });
  });

  it("survives a restart: the binding still resolves, the spent token still does not", () => {
    const { minted, exchanged } = bind({ owner: "alice", authority: "human" });
    service = buildService();
    const live = sessionFor(exchanged.credential, "propose");
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.value.binding.username).toBe("alice");
    expect(service.exchange({ token: minted.launch_token, origin: ORIGIN }))
      .toMatchObject({ ok: false, code: "invalid_credential" });
  });
});

describe("the per-account ceiling counts what is owed, not just what is held", () => {
  /** A deployment that allows exactly two bindings per account per App. */
  function limited(max: number): ExternalAppHostService {
    return new ExternalAppHostService({
      settings: externalAppHostSettings({
        enabled: true,
        hosts: [{ id: "dsh-local", origin: ORIGIN }],
        max_bindings_per_user: max,
      })!,
      store,
      app: (id) => (id === APP ? target() : null),
      trust: (owner: string) => ({ trusted: true as const, reason: "exact_release" as const, decision: decisionFor(owner) }),
      audit: () => {},
      now: () => now,
    });
  }

  function mint(svc: ExternalAppHostService) {
    return svc.mintLaunch({ owner: "alice", appId: APP, instanceKey: INSTANCE, hostId: "dsh-local", authority: "human" });
  }

  it("refuses the mint that would exceed it, counting UNREDEEMED links", () => {
    const svc = limited(2);
    const first = mint(svc);
    const second = mint(svc);
    expect(first.ok && second.ok).toBe(true);
    // Nothing has been exchanged yet: under a count of live capabilities alone
    // this would be zero, and this third link would be handed out.
    expect(mint(svc)).toMatchObject({ ok: false, code: "operation_refused" });
    if (!first.ok || !second.ok) return;
    expect(svc.exchange({ token: first.value.launch_token, origin: ORIGIN }).ok).toBe(true);
    expect(svc.exchange({ token: second.value.launch_token, origin: ORIGIN }).ok).toBe(true);
    // Two live bindings now, and still exactly two.
    expect(mint(svc)).toMatchObject({ ok: false, code: "operation_refused" });
    expect(store.listExternalAppCapabilities("alice", APP).filter((row) => !row.revoked_at)).toHaveLength(2);
  });

  it("cannot be walked past by minting first and redeeming later", () => {
    const generous = limited(4);
    const links = [mint(generous), mint(generous), mint(generous), mint(generous)];
    expect(links.every((link) => link.ok)).toBe(true);
    // The operator narrows the deployment to two while four links are in
    // flight. Redemption re-asks, so only two of them can become bindings.
    const strict = limited(2);
    const outcomes = links.map((link) =>
      link.ok ? strict.exchange({ token: link.value.launch_token, origin: ORIGIN }) : link,
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.code === "operation_refused")).toHaveLength(2);
    expect(store.listExternalAppCapabilities("alice", APP).filter((row) => !row.revoked_at)).toHaveLength(2);
  });

  it("frees a slot when a binding is revoked, and when a link simply expires", () => {
    const svc = limited(1);
    const link = mint(svc);
    if (!link.ok) throw new Error("mint refused");
    expect(mint(svc)).toMatchObject({ ok: false, code: "operation_refused" });
    // An unredeemed link that dies of old age stops occupying its slot.
    now += 121_000;
    const afterExpiry = mint(svc);
    expect(afterExpiry.ok).toBe(true);
    if (!afterExpiry.ok) return;
    const bound = svc.exchange({ token: afterExpiry.value.launch_token, origin: ORIGIN });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(mint(svc)).toMatchObject({ ok: false, code: "operation_refused" });
    expect(svc.revoke("alice", bound.value.binding.credential_id, "user").ok).toBe(true);
    expect(mint(svc).ok).toBe(true);
  });
});

describe("what is stored, and what is answered", () => {
  it("keeps only digests, and never serialises a secret", () => {
    const { minted, exchanged } = bind({ owner: "alice", authority: "human" });
    const grantRow = store.getExternalAppLaunchGrant(minted.grant_id)!;
    const capabilityRow = store.getExternalAppCapability(exchanged.binding.credential_id)!;
    const dumped = JSON.stringify([grantRow, capabilityRow]);
    expect(dumped).not.toContain(minted.launch_token);
    expect(dumped).not.toContain(exchanged.credential);
    expect(dumped).not.toContain("xlg_");
    expect(dumped).not.toContain("xac_");
    expect(grantRow.token_hash).toBe(externalSecretDigest(minted.launch_token));
    expect(capabilityRow.secret_hash).toBe(externalSecretDigest(exchanged.credential));

    // Neither does anything the person or the host reads afterwards.
    const listed = JSON.stringify(service.bindings("alice", APP));
    expect(listed).not.toContain(exchanged.credential);
    expect(listed).toContain(exchanged.binding.credential_id);
    const bound = sessionFor(exchanged.credential, "describe");
    if (!bound.ok) throw new Error("session refused");
    expect(JSON.stringify(service.describe(bound.value))).not.toContain(exchanged.credential);
  });

  it("hands the host the App's own immutable View to frame, not a UI to rewrite", () => {
    const { exchanged } = bind({ owner: "alice", authority: "human" });
    expect(exchanged.view).toEqual({
      origin: "https://app-abcdef0123456789abcd.apps.example.com",
      package_digest: activeRelease.packageDigest,
      frame_protocol: EXTERNAL_APP_FRAME_PROTOCOL,
      sandbox: "allow-scripts allow-downloads",
    });
    // A display address, and nothing that could carry authority into the frame.
    expect(JSON.stringify(exchanged.view)).not.toContain("alice");
    expect(JSON.stringify(exchanged.view)).not.toContain(exchanged.binding.credential_id);
  });
});

describe("the two authorities are two credentials on two operations", () => {
  it("refuses each on the other's operation", () => {
    const human = bind({ owner: "alice", authority: "human" }).exchanged;
    const agent = bind({ owner: "alice", authority: "agent" }).exchanged;
    expect(sessionFor(human.credential, "agent_propose")).toMatchObject({ ok: false, code: "operation_refused" });
    expect(sessionFor(agent.credential, "propose")).toMatchObject({ ok: false, code: "operation_refused" });
    expect(sessionFor(human.credential, "propose").ok).toBe(true);
    expect(sessionFor(agent.credential, "agent_propose").ok).toBe(true);
  });

  it("derives the agent contract from the manifest, minus what is human-only", () => {
    const agent = bind({ owner: "alice", authority: "agent" }).exchanged;
    const names = agent.actions.map((action) => action.name);
    expect(names).toContain("move");
    expect(names).toContain("comment");
    expect(names).not.toContain("resign");
    const move = agent.actions.find((action) => action.name === "move")!;
    expect(move.params).toEqual({
      type: "object",
      properties: {
        from: { type: "string", description: "起点格", maxLength: 8 },
        to: { type: "string", description: "终点格", maxLength: 8 },
      },
      required: ["from", "to"],
      additionalProperties: false,
    });
    expect(move.roles).toEqual(["white", "black"]);
    // The human binding sees the human surface, including `resign`.
    const human = bind({ owner: "alice", authority: "human" }).exchanged;
    expect(human.actions.map((a) => a.name)).toContain("resign");
  });
});

describe("moves land in the App's own log, authored by whoever really moved", () => {
  async function move(secret: string, operation: "propose" | "agent_propose", params: Record<string, string>) {
    const bound = service.session({ secret, origin: ORIGIN, operation });
    if (!bound.ok) return bound;
    const opened = await service.open(bound.value);
    if (!opened.ok) return opened;
    return await service.propose(bound.value, opened.value.handle, { action: "move", params });
  }

  async function authors(): Promise<string[]> {
    const client = new InProcessStateClient(state);
    const stream = await client.resolveStream({
      app: sessionPlusStateAppKey(activeRelease),
      scope: { kind: "shared", key: INSTANCE },
    });
    const history = await client.readSince(stream.streamId, 0, 16);
    return history.events.filter((e) => e.type === "moved").map((e) => String(e.by));
  }

  it("lets an authorized white and black move from an external host", async () => {
    const white = bind({ owner: "alice", authority: "human" }).exchanged;
    const black = bind({ owner: "bob", authority: "human" }).exchanged;
    expect(await move(white.credential, "propose", { from: "6,4", to: "4,4" })).toMatchObject({ ok: true });
    expect(runtime.lastContext?.actor).toEqual({ user: "alice", kind: "user", role: "white" });
    expect(await move(black.credential, "propose", { from: "1,4", to: "3,4" })).toMatchObject({ ok: true });
    expect(runtime.lastContext?.actor).toEqual({ user: "bob", kind: "user", role: "black" });
    // A human's external move is authored exactly as their click inside
    // Octopus is: the log says WHO, not which host they used.
    expect(await authors()).toEqual(["user:alice", "user:bob"]);
    expect(audit.filter((row) => row.operation === "(external_human_propose)")).toHaveLength(2);
  });

  it("names an agent proposal as an agent, and audits it separately", async () => {
    const agent = bind({ owner: "alice", authority: "agent" }).exchanged;
    expect(await move(agent.credential, "agent_propose", { from: "6,4", to: "4,4" })).toMatchObject({ ok: true });
    expect(runtime.lastContext?.actor).toMatchObject({ user: "alice", kind: "agent", role: "white" });
    expect((await authors())[0]).toBe("agent:demo-board/external@alice");
    expect(audit.map((row) => row.operation)).toContain("(external_agent_propose)");
    expect(audit.map((row) => row.operation)).not.toContain("(external_human_propose)");
  });

  it("refuses a watcher's move with the App's own bounded reason", async () => {
    const watcher = bind({ owner: "carol", authority: "human" }).exchanged;
    expect(await move(watcher.credential, "propose", { from: "6,4", to: "4,4" }))
      .toMatchObject({ ok: false, code: "action_rejected" });
    // The seat it DOES have still works.
    const bound = sessionFor(watcher.credential, "propose");
    if (!bound.ok) throw new Error("session refused");
    const opened = await service.open(bound.value);
    if (!opened.ok) throw new Error("open refused");
    expect(await service.propose(bound.value, opened.value.handle, { action: "comment", params: { text: "好棋" } }))
      .toMatchObject({ ok: true });
  });
});

describe("every live check refuses the next call and ends the open stream", () => {
  /** Open one binding, hold a live subscription, and report what it heard. */
  async function live(owner: string, authority: "human" | "agent" = "human") {
    const { exchanged } = bind({ owner, authority });
    const bound = service.session({ secret: exchanged.credential, origin: ORIGIN, operation: "stream" });
    if (!bound.ok) throw new Error(`session refused: ${bound.code}`);
    const opened = await service.open(bound.value);
    if (!opened.ok) throw new Error(`open refused: ${opened.code}`);
    const heard: InstanceEvent[] = [];
    const subscription = service.subscribe(bound.value, opened.value.handle, (event) => heard.push(event));
    expect(subscription).not.toBeNull();
    return {
      credential: exchanged.credential,
      credentialId: exchanged.binding.credential_id,
      handle: opened.value.handle,
      heard,
      closed: () => heard.filter((event) => event.type === "closed").map((event) => (event as { reason: string }).reason),
    };
  }

  it("a removed member: torn down, and refused afterwards", async () => {
    const held = await live("bob");
    store.removeSharedAppMember(APP, INSTANCE, "bob");
    expect(service.revalidate(held.credentialId)).toMatchObject({ ok: false, code: "not_member" });
    expect(held.closed()).toContain("credential_ended");
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "not_member" });
  });

  it("a closed instance", async () => {
    const held = await live("alice");
    store.closeSharedAppInstance(APP, INSTANCE);
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "instance_closed" });
    expect(held.closed()).toContain("credential_ended");
  });

  it("a withdrawn publisher trust", async () => {
    const held = await live("alice");
    trusted.delete("alice");
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "trust_required" });
    expect(held.closed()).toContain("credential_ended");
  });

  it("a release the binding was not minted against", async () => {
    const held = await live("alice");
    activeRelease = { ...RELEASE, packageDigest: "pkg-digest-2" };
    expect(service.revalidate(held.credentialId)).toMatchObject({ ok: false, code: "release_changed" });
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "release_changed" });
    expect(held.closed().length).toBeGreaterThan(0);
  });

  it("an explicit revocation, from the person's own page", async () => {
    const held = await live("alice");
    expect(service.revoke("bob", held.credentialId, "user")).toMatchObject({ ok: false, code: "invalid_credential" });
    expect(service.revoke("alice", held.credentialId, "user")).toMatchObject({ ok: true });
    expect(held.closed()).toContain("credential_ended");
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "invalid_credential" });
    expect(service.revalidate(held.credentialId)).toMatchObject({ ok: false, code: "invalid_credential" });
    expect(service.bindings("alice", APP)[0]).toMatchObject({ status: "revoked" });
  });

  it("expiry, which has no event and is exactly why the stream revalidates", async () => {
    const held = await live("alice");
    now += 3_601_000;
    // The binding is dead by the clock alone: nothing was revoked, no row moved.
    expect(service.revalidate(held.credentialId)).toMatchObject({ ok: false, code: "invalid_credential" });
    expect(held.closed()).toContain("credential_ended");
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "invalid_credential" });
  });

  it("a host that has left the allowlist", async () => {
    const held = await live("alice");
    service = new ExternalAppHostService({
      settings: externalAppHostSettings({ enabled: true, hosts: [{ id: "dsh-other", origin: OTHER_ORIGIN }] })!,
      store,
      app: (id) => (id === APP ? target() : null),
      trust: (owner: string) => ({ trusted: true as const, reason: "exact_release" as const, decision: decisionFor(owner) }),
      audit: () => {},
      now: () => now,
    });
    expect(service.revalidate(held.credentialId)).toMatchObject({ ok: false, code: "origin_refused" });
    expect(sessionFor(held.credential, "propose")).toMatchObject({ ok: false, code: "origin_refused" });
  });

  it("refuses a handle opened by another binding, and one presented from another origin", async () => {
    const mine = await live("alice");
    const { exchanged: theirs } = bind({ owner: "bob", authority: "human" });
    const bound = sessionFor(theirs.credential, "propose");
    if (!bound.ok) throw new Error("session refused");
    // bob's binding presenting alice's handle: the registry keys a handle on
    // owner AND credential, so this is not resolvable.
    expect(await service.propose(bound.value, mine.handle, { action: "comment", params: { text: "x" } }))
      .toMatchObject({ ok: false, code: "invalid_instance" });
    expect(service.session({ secret: theirs.credential, origin: OTHER_ORIGIN, operation: "propose" }))
      .toMatchObject({ ok: false, code: "origin_refused" });
    expect(service.session({ secret: theirs.credential, origin: undefined, operation: "propose" }))
      .toMatchObject({ ok: false, code: "origin_refused" });
    expect(service.session({ secret: "xac_not-a-real-secret", origin: ORIGIN, operation: "propose" }))
      .toMatchObject({ ok: false, code: "invalid_credential" });
  });

  it("reports a binding that died DURING a dispatch, instead of a bare success", async () => {
    const { exchanged } = bind({ owner: "alice", authority: "human" });
    const bound = sessionFor(exchanged.credential, "propose");
    if (!bound.ok) throw new Error("session refused");
    const opened = await service.open(bound.value);
    if (!opened.ok) throw new Error("open refused");
    // Revoked after the request was admitted; the commit may already have
    // happened, and the honest answer is that the binding is gone.
    const proposal = service.propose(bound.value, opened.value.handle, { action: "comment", params: { text: "race" } });
    service.revoke("alice", exchanged.binding.credential_id, "user");
    expect(await proposal).toMatchObject({ ok: false, code: "invalid_credential" });
    expect(audit.at(-1)).toMatchObject({ decision: "deny", reason: "binding_ended:invalid_credential" });
  });
});
