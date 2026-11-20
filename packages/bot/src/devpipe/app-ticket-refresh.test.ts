/**
 * The refresher is a five-step pipeline whose whole value is that each step's
 * refusal is DISTINGUISHABLE — "the build was stale" and "the backend would not
 * come up" send an operator to different places, and the ticket conversation is
 * where they read it. So every step gets a case here.
 *
 * The packer itself is injected. Spawning `pnpm run app:pack` for real would be
 * testing pnpm; what this file is about is what the bot does with the bytes.
 */

import { describe, it, expect, vi } from "vitest";
import type { AppReleaseDescriptor, AppReleaseRegistry } from "@claude-bot/app-registry";
import { bundleToWire, type ReleaseBundle } from "../app-registry/bundle.js";
import type {
  ActivateResult,
  ActivationPreview,
  InstallResult,
  ManagedApp,
  SimpleResult,
} from "../app-registry/hosted-app.js";
import { AppReleaseHost } from "../app-registry/release-host.js";
import { createAppTicketRefresher, createAppTicketReleaseTools } from "./app-ticket-refresh.js";

const DIGEST = "b".repeat(64);

it("App-only publication uses the remote packer without running the local View build", async () => {
  const { app } = fakeApp();
  const buildView = vi.fn(async () => ({ ok: true, log: "must not run" }));
  const pack = vi.fn(async () => ({ ok: false, log: "must not run" }));
  const remotePack = vi.fn(packWriting(bundleFor()));
  const refresh = createAppTicketRefresher({ host: hostWith([app]), remotePack, buildView, pack });
  expect(await refresh({ ...INPUT, prepareView: true })).toMatchObject({ ok: true });
  expect(remotePack).toHaveBeenCalledOnce();
  expect(buildView).not.toHaveBeenCalled();
  expect(pack).not.toHaveBeenCalled();
});

function descriptorFor(stableAppId: string, publisher: string): AppReleaseDescriptor {
  // Only the three fields this layer routes on matter; `install()` in production
  // recomputes every digest from the bytes, and here `install` is the fake.
  return { stableAppId, publisher, packageDigest: DIGEST } as unknown as AppReleaseDescriptor;
}

function bundleFor(stableAppId = "session-plus", publisher = "octopus"): ReleaseBundle {
  return {
    descriptor: descriptorFor(stableAppId, publisher),
    assets: [{ name: "view/app.js", content: new Uint8Array([1, 2, 3]) }],
    provenance: {
      kind: "platform-built",
      builder: "test",
      statement: "test",
      signatureVerification: "none",
    } as ReleaseBundle["provenance"],
  };
}

interface FakeAppOptions {
  install?: InstallResult;
  activate?: ActivateResult;
  preview?: ActivationPreview;
}

function fakeApp(options: FakeAppOptions = {}) {
  const calls: { install: string[]; activate: string[] } = { install: [], activate: [] };
  const app: ManagedApp = {
    appId: "session-plus",
    publisher: "octopus",
    start: async () => null,
    unavailable: () => null,
    publishedLabels: () => new Set<string>(),
    documentFor: async () => null,
    install: (_bundle, by) => {
      calls.install.push(by);
      return options.install ?? { ok: true, packageDigest: DIGEST, deduplicated: false };
    },
    previewActivation: async () => options.preview ?? ({
      ok: true,
      release: {} as never,
      packageDigest: DIGEST,
      previousPackageDigest:
        options.activate?.ok === true ? options.activate.previousPackageDigest : null,
      permissionContractDigest: "c".repeat(64),
      coexistence: options.activate?.ok === true ? options.activate.coexistence : "multi_version",
      reason: options.activate?.ok === true ? options.activate.reason : null,
    } as ActivationPreview),
    activate: async (_digest, by) => {
      calls.activate.push(by);
      return (
        options.activate
        ?? ({
          ok: true,
          release: {} as never,
          previousPackageDigest: null,
          changed: true,
          coexistence: "multi_version",
          reason: null,
        } as ActivateResult)
      );
    },
    deactivate: async () => ({ ok: true, changed: false }) as SimpleResult,
    uninstall: () => ({ ok: true, changed: false }) as SimpleResult,
    describe: () => ({}) as never,
  };
  return { app, calls };
}

function hostWith(apps: ManagedApp[]): AppReleaseHost {
  return new AppReleaseHost({ registry: {} as AppReleaseRegistry, apps });
}

/** A packer that writes a real bundle document, the way the CLI does. */
function packWriting(bundle: ReleaseBundle) {
  return async ({ out }: { out: string }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, `${JSON.stringify(bundleToWire(bundle))}\n`, "utf8");
    return { ok: true, log: "packed" };
  };
}

const INPUT = { appId: "session-plus", worktree: "/tmp/wt", ticketId: 7, actor: "devpipe:ticket-7" };

describe("createAppTicketRefresher", () => {
  it("prepare installs and previews exact bytes without activating them", async () => {
    const { app, calls } = fakeApp();
    const tools = createAppTicketReleaseTools({ host: hostWith([app]), pack: packWriting(bundleFor()) });

    const outcome = await tools.prepare(INPUT);

    expect(outcome).toMatchObject({
      ok: true,
      packageDigest: DIGEST,
      previousPackageDigest: null,
      permissionContractDigest: "c".repeat(64),
      coexistence: "multi_version",
    });
    expect(calls.install).toEqual(["devpipe:ticket-7"]);
    expect(calls.activate).toEqual([]);
  });

  it("packs, installs and activates, reporting the digest that is now served", async () => {
    const { app, calls } = fakeApp();
    const refresh = createAppTicketRefresher({ host: hostWith([app]), pack: packWriting(bundleFor()) });

    const outcome = await refresh(INPUT);

    expect(outcome).toMatchObject({
      ok: true,
      appId: "session-plus",
      packageDigest: DIGEST,
      deduplicated: false,
      changed: true,
      coexistence: "multi_version",
      coexistenceReason: null,
    });
    // Both writes are attributed to the ticket, so `/apps` shows who published
    // and an operator can find the conversation that decided it.
    expect(calls.install).toEqual(["devpipe:ticket-7"]);
    expect(calls.activate).toEqual(["devpipe:ticket-7"]);
    expect(outcome.ok && outcome.hostLabel).toMatch(/^app-[0-9a-f]{20}$/);
  });

  it("reports «already active» rather than claiming a change that did not happen", async () => {
    const { app } = fakeApp({
      install: { ok: true, packageDigest: DIGEST, deduplicated: true },
      activate: {
        ok: true,
        release: {} as never,
        previousPackageDigest: DIGEST,
        changed: false,
        coexistence: "multi_version",
        reason: null,
      },
    });
    const refresh = createAppTicketRefresher({ host: hostWith([app]), pack: packWriting(bundleFor()) });

    expect(await refresh(INPUT)).toMatchObject({ ok: true, deduplicated: true, changed: false });
  });

  it("a failed pack surfaces the packer's own output — that is where «stale build» is said", async () => {
    const { app, calls } = fakeApp();
    const refresh = createAppTicketRefresher({
      host: hostWith([app]),
      pack: async () => ({ ok: false, log: "app:pack 失败: View 产物与源码 digest 不一致" }),
    });

    const outcome = await refresh(INPUT);
    expect(outcome).toMatchObject({ ok: false, step: "pack", code: "pack_failed" });
    expect(outcome.ok === false && outcome.message).toContain("digest 不一致");
    // Nothing was published, and — crucially — nothing was even attempted.
    expect(calls.install).toEqual([]);
    expect(calls.activate).toEqual([]);
  });

  it("a pack that writes nothing readable is a pack failure, not a crash", async () => {
    const { app } = fakeApp();
    const refresh = createAppTicketRefresher({
      host: hostWith([app]),
      pack: async () => ({ ok: true, log: "claimed success" }),
    });
    expect(await refresh(INPUT)).toMatchObject({ ok: false, step: "pack", code: "pack_unreadable" });
  });

  it("a document that is not a bundle is refused before any registry call", async () => {
    const { app, calls } = fakeApp();
    const refresh = createAppTicketRefresher({
      host: hostWith([app]),
      pack: async ({ out }) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(out, JSON.stringify({ kind: "something-else" }), "utf8");
        return { ok: true, log: "" };
      },
    });
    expect(await refresh(INPUT)).toMatchObject({ ok: false, step: "pack", code: "bundle_rejected" });
    expect(calls.install).toEqual([]);
  });

  it("a bundle for a different App is refused naming the TICKET's App", async () => {
    // `install()` routes on the descriptor, so without this check the operator
    // would read `unknown_app` about an App they never mentioned.
    const { app, calls } = fakeApp();
    const refresh = createAppTicketRefresher({
      host: hostWith([app]),
      pack: packWriting(bundleFor("some-other-app")),
    });

    const outcome = await refresh(INPUT);
    expect(outcome).toMatchObject({ ok: false, step: "pack", code: "wrong_app" });
    expect(outcome.ok === false && outcome.message).toContain("session-plus");
    expect(calls.install).toEqual([]);
  });

  it("an install refusal stops before activation and carries the registry's issues", async () => {
    const { app, calls } = fakeApp({
      install: {
        ok: false,
        failure: {
          code: "install_rejected",
          message: "release 未通过校验",
          issues: [{ code: "asset_digest", message: "view/app.js 的 sha256 不符" }],
        },
      },
    });
    const refresh = createAppTicketRefresher({ host: hostWith([app]), pack: packWriting(bundleFor()) });

    const outcome = await refresh(INPUT);
    expect(outcome).toMatchObject({ ok: false, step: "install", code: "install_rejected" });
    expect(outcome.ok === false && outcome.message).toContain("asset_digest");
    expect(calls.activate).toEqual([]);
  });

  it("an activation refusal is its own step — the release is installed, just not served", async () => {
    const { app, calls } = fakeApp({
      activate: {
        ok: false,
        failure: { code: "runtime_unhealthy", message: "候选 release 的应用后端没有通过健康检查" },
      },
    });
    const refresh = createAppTicketRefresher({ host: hostWith([app]), pack: packWriting(bundleFor()) });

    const outcome = await refresh(INPUT);
    expect(outcome).toMatchObject({ ok: false, step: "activate", code: "runtime_unhealthy" });
    // Installed is still installed: an operator can activate it by hand later,
    // or roll forward from a fixed build.
    expect(calls.install).toEqual(["devpipe:ticket-7"]);
  });

  it("an App this process does not host is «unsupported», and says what it does host", async () => {
    const { app } = fakeApp();
    const other: ManagedApp = { ...app, appId: "something-else" };
    const refresh = createAppTicketRefresher({ host: hostWith([other]), pack: packWriting(bundleFor()) });

    const outcome = await refresh(INPUT);
    expect(outcome).toMatchObject({ ok: false, step: "unsupported", code: "unknown_app" });
    expect(outcome.ok === false && outcome.message).toContain("something-else");
  });

  it("declares a missing repository App only when an explicit host action requests it", async () => {
    const { app, calls } = fakeApp();
    const host = hostWith([]);
    const declarations: unknown[] = [];
    const refresh = createAppTicketRefresher({
      host,
      pack: packWriting(bundleFor()),
      declareApp: async (input) => {
        declarations.push(input);
        await host.addApp(app);
        return { ok: true, app: input.stableAppId, publisher: input.publisher, title: input.title };
      },
    });

    const outcome = await refresh({ ...INPUT, declareMissing: true, actor: "user:root" });

    expect(outcome).toMatchObject({ ok: true, appId: "session-plus" });
    expect(declarations).toEqual([
      expect.objectContaining({ stableAppId: "session-plus", publisher: "octopus", by: "user:root" }),
    ]);
    expect(calls.install).toEqual(["user:root"]);
    expect(calls.activate).toEqual(["user:root"]);
  });

  it("runs the App-scoped View build before packing an ahead App worktree", async () => {
    const { app } = fakeApp();
    const order: string[] = [];
    const refresh = createAppTicketRefresher({
      host: hostWith([app]),
      buildView: async (input) => {
        order.push(`build:${input.project}`);
        return { ok: true, log: "built" };
      },
      pack: async (input) => {
        order.push("pack");
        return packWriting(bundleFor())(input);
      },
    });

    expect(await refresh({ ...INPUT, prepareView: true })).toMatchObject({ ok: true });
    expect(order).toEqual(["build:session-plus-view", "pack"]);
  });

  it("an App with no packer in this repo is «unsupported», distinct from «not hosted»", async () => {
    const { app } = fakeApp();
    const refresh = createAppTicketRefresher({ host: hostWith([app]), pack: packWriting(bundleFor()) });
    // Not in APP_TICKET_SCOPES at all: there is no packing path to run, which is
    // a repository fact rather than a deployment one — different reader, so a
    // different code.
    expect(await refresh({ ...INPUT, appId: "declared-thing" })).toMatchObject({
      ok: false,
      step: "unsupported",
      code: "not_ticketable",
    });
  });

  it("never throws: a packer that blows up becomes a bounded outcome", async () => {
    const { app } = fakeApp();
    const refresh = createAppTicketRefresher({
      host: hostWith([app]),
      pack: async () => {
        throw new Error("spawn ENOENT\u0007\u001b[31m");
      },
    });
    const outcome = await refresh(INPUT);
    expect(outcome).toMatchObject({ ok: false, code: "refresh_crashed" });
    // The text goes straight into a ticket conversation, so control characters
    // are flattened rather than passed through into somebody’s terminal.
    expect(outcome.ok === false && outcome.message).toContain("spawn ENOENT");
    // eslint-disable-next-line no-control-regex
    expect(outcome.ok === false && outcome.message).not.toMatch(/[\u0000-\u001f]/);
  });
});
