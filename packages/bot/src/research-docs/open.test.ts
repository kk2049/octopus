import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { AppStateService, InProcessStateClient } from "@claude-bot/app-state";
import type { AppRuntimeClient, RuntimeJson } from "@claude-bot/app-runtime";
import {
  AppReleaseRegistry,
  FileReleaseContentStore,
  MemoryReleaseCatalog,
} from "@claude-bot/app-registry";
import {
  DOCS_APP,
  DOCS_OPERATIONS,
  type PageInfo,
  type DocumentState,
  type LibraryPage,
} from "@claude-bot/research-docs-contract";
import { AppReleaseHost } from "../app-registry/release-host.js";
import { DashboardServer, mintDashboardToken } from "../dashboard/server.js";
import { composeDashboardServices } from "../bootstrap-v3.js";
import {
  AppInstanceService,
  type AppInstanceRelease,
} from "../app-registry/app-instance.js";
import { Store } from "../store/store.js";
import { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import {
  buildAppBundle,
  readAppPackConfig,
} from "../app-registry/app-package.js";
import type { ManagedApp } from "../app-registry/hosted-app.js";
import type { ResearchCanvasPlane } from "../research-canvas/plane.js";
import { DOCS_DIGEST } from "./contract.js";
import type { ResearchDocsPlane } from "./plane.js";
import { browserAcceptance } from "./browser-acceptance.js";

it(
  "opens reviewed shared documents through HTTP, enforces real roles and source boundaries, and revokes live access",
  { timeout: process.env.RESEARCH_DOCS_BROWSER ? 300000 : 120000 },
  async () => {
    const {
      project,
    }: { project(events: readonly unknown[], context?: unknown): RuntimeJson } =
      await import(
        new URL(
          "../../../research-docs-view/app/projection.ts",
          import.meta.url,
        ).href
      );
    const root = mkdtempSync(join(tmpdir(), "docs-open-")),
      store = new Store(join(root, "bot.db")),
      state = new AppStateService(join(root, "state"));
    const supervisor = new ManagedExecutionSupervisor(
        store.managedExecutions,
        new ResourceRecoveryService(store.resourceWaiters),
      ),
      at = new Date().toISOString();
    for (const [i, username] of ["alice", "bob", "viewer"].entries())
      store.saveUser({
        username,
        uid: 1001 + i,
        home_dir: root,
        created_at: at,
      });
    const release: AppInstanceRelease = {
      stableAppId: DOCS_APP,
      publisher: "octopus:first-party",
      packageDigest: "a".repeat(64),
      permissionContractDigest: DOCS_DIGEST,
      backendCodeDigest: "b".repeat(64),
      appDir: fileURLToPath(
        new URL("../../../research-docs-view/app/", import.meta.url),
      ),
    };
    const registry = new AppReleaseRegistry({
        catalog: new MemoryReleaseCatalog(),
        content: new FileReleaseContentStore(join(root, "releases")),
      }),
      owners: ManagedApp[] = [];
    if (process.env.RESEARCH_DOCS_BROWSER) {
      const config = await import(
          new URL("../../../research-docs-view/src/pack.ts", import.meta.url)
            .href
        ),
        bundle = await buildAppBundle(readAppPackConfig(config.default));
      const installed = registry.install({
        ...bundle,
        installedBy: "docs-browser-test",
      });
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      release.packageDigest = bundle.descriptor.packageDigest;
      const unused = (): never => {
        throw new Error("asset owner cannot activate a backend");
      };
      owners.push({
        appId: DOCS_APP,
        publisher: release.publisher,
        start: unused,
        unavailable: unused,
        install: unused,
        activate: unused,
        deactivate: unused,
        uninstall: unused,
        describe: unused,
        publishedLabels: unused,
        documentFor: unused,
      });
    }
    const runtime: AppRuntimeClient = {
      project: async (r) => project(r.events, r.context),
      invoke: async () => {
        throw new Error("resource actions cannot enter sandbox");
      },
      health: async () => ({
        ok: true,
        backendCodeDigest: release.backendCodeDigest,
      }),
    };
    const service = new AppInstanceService({
      stableAppId: DOCS_APP,
      state: new InProcessStateClient(state),
      runtime,
      activeRelease: () => release,
      servableRelease: (digest) =>
        digest === release.packageDigest ? release : null,
      servablePackageDigests: () => new Set([release.packageDigest]),
      shared: {
        instance: (app, id) => store.getSharedAppInstance(app, id),
        member: (app, id, owner) => store.getSharedAppMember(app, id, owner),
      },
    });
    const surface = {
      stableAppId: DOCS_APP,
      publisher: release.publisher,
      title: "研究文档",
      packageDigest: release.packageDigest,
      viewOrigin: "http://app.local",
      service,
      unavailable: null,
    };
    let plane!: ResearchDocsPlane, source!: ResearchCanvasPlane;
    const composition = composeDashboardServices(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "test-admin",
      adminUsers: [],
      surface: "bootstrap-v3",
      appReleases: new AppReleaseHost({ registry, apps: owners }),
      declaredApps: {
        list: () => [surface],
        get: (app) => (app === DOCS_APP ? surface : null),
      },
      managedSupervisor: supervisor,
      researchCanvas: {
        root: join(root, "research"),
        model: {
          baseUrl: "",
          apiKey: "",
          models: [],
          defaultModel: "",
          filterModel: "",
        },
      },
      attachDeclaredResources: (factory) => {
        plane = factory(DOCS_APP, release.publisher) as ResearchDocsPlane;
        source = factory(
          "research-v2",
          release.publisher,
        ) as ResearchCanvasPlane;
        return () => {};
      },
    });
    service.attachResources(plane);
    const server = new DashboardServer(
      composition.options,
      composition.services,
    );
    composition.attachTransport(server.transportLifecycle);
    const space = "asi_" + "d".repeat(32),
      other = "asi_" + "e".repeat(32),
      sourceSpace = "asi_" + "f".repeat(32);
    for (const id of [space, other])
      store.createSharedAppInstance(
        {
          app_id: DOCS_APP,
          instance_key: id,
          creator: "alice",
          status: "open",
          created_at: at,
        },
        "owner",
      );
    store.addSharedAppMember(DOCS_APP, space, "bob", "editor", 64, at);
    store.addSharedAppMember(DOCS_APP, space, "viewer", "viewer", 64, at);
    store.createSharedAppInstance(
      {
        app_id: "research-v2",
        instance_key: sourceSpace,
        creator: "alice",
        status: "open",
        created_at: at,
      },
      "owner",
    );
    try {
      await server.start();
      const base = "http://127.0.0.1:" + server.port;
      const clients = await Promise.all(
        ["alice", "bob", "viewer"].map(async (owner) => {
          const response = await fetch(base + "/login", {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/json", origin: base },
            body: JSON.stringify({ token: mintDashboardToken(store, owner) }),
          });
          const cookies = response.headers.getSetCookie(),
            cookie = cookies
              .find((c) => c.startsWith("octopus_sess="))!
              .split(";")[0],
            csrf = /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(";"))![1];
          const post = (path: string, body: unknown) =>
            fetch(base + path, {
              method: "POST",
              headers: {
                cookie,
                origin: base,
                "x-csrf-token": csrf,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            });
          expect(
            (
              await post("/api/app-view/trust?app=" + DOCS_APP, {
                decision: "trust",
              })
            ).status,
          ).toBe(200);
          const principal = {
            owner,
            credential: "test:" + owner,
            session: true,
          };
          const opened = await service.open(principal, { instanceKey: space });
          const dispatch = (
            action: string,
            params: Record<string, string> = {},
          ) => service.dispatch(opened.handle, principal, { action, params });
          return { owner, cookies, post, principal, opened, dispatch };
        }),
      );
      const [alice, bob, viewer] = clients;
      expect(await alice.dispatch("library")).toMatchObject({ ok: false });
      for (const c of clients)
        expect(
          (
            await c.post("/api/permissions/grant", {
              subject_type: "app",
              subject_id: DOCS_APP,
              operations: [...DOCS_OPERATIONS],
            })
          ).status,
        ).toBe(200);
      expect(
        await viewer.dispatch("create", { request: "bad", title: "readonly" }),
      ).toMatchObject({ ok: false });
      const created = await alice.dispatch("create", {
        request: "acc-home",
        title: "ACC · 研究主页",
        seed: JSON.stringify([
          { type: "heading", content: "研究概览", props: { level: 2 } },
          { type: "paragraph", content: "把问题、资料与实验进展写在一起。" },
        ]),
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) throw new Error(created.message);
      const page = created.result as unknown as PageInfo;
      const read = await alice.dispatch("read", { doc: page.id });
      if (!read.ok) throw new Error(read.message);
      const a = new Y.Doc(),
        b = new Y.Doc(),
        initial = read.result as unknown as DocumentState;
      for (const d of [a, b])
        Y.applyUpdate(d, Buffer.from(initial.update, "base64"));
      a.getText("acceptance").insert(0, "alice");
      b.getText("acceptance").insert(0, "bob");
      for (const [c, d] of [
        [alice, a],
        [bob, b],
      ] as const)
        expect(
          await c.dispatch("update", {
            doc: page.id,
            update: Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64"),
            vector: Buffer.from(Y.encodeStateVector(d)).toString("base64"),
          }),
        ).toMatchObject({ ok: true });
      const response = await alice.dispatch("read", { doc: page.id });
      if (!response.ok) throw new Error(response.message);
      const merged = response.result as unknown as DocumentState;
      Y.applyUpdate(a, Buffer.from(merged.update, "base64"));
      Y.applyUpdate(b, Buffer.from(merged.update, "base64"));
      expect(a.getText("acceptance").toString()).toBe(
        b.getText("acceptance").toString(),
      );
      a.destroy();
      b.destroy();
      // A page past the old 2 MiB ceiling (and the 4 MiB library bound): pushed in
      // window-sized parts through the real App dispatch, opened in windows by another member.
      const big = new Y.Doc();
      Y.applyUpdate(big, Buffer.from(merged.update, "base64"));
      big.getText("large").insert(0, "长文档段落。".repeat(5 * 1024 * 1024 / 18 + 1000));
      const push = Y.encodeStateAsUpdate(big),
        vector = Buffer.from(Y.encodeStateVector(big)).toString("base64"),
        window = 196_608;
      expect(push.length).toBeGreaterThan(5 * 1024 * 1024);
      let pushed: { ok: boolean; result?: unknown; message?: string } | undefined;
      for (let offset = 0; offset < push.length; offset += window) {
        pushed = await alice.dispatch("update", {
          doc: page.id,
          update: Buffer.from(push.subarray(offset, offset + window)).toString("base64"),
          vector,
          offset: String(offset),
          total: String(push.length),
        });
        expect(pushed.ok, JSON.stringify(pushed).slice(0, 300)).toBe(true);
      }
      expect(pushed!.result).toMatchObject({ next: null });
      // An older View (no offset) is told to refresh rather than given a partial page.
      expect(await bob.dispatch("read", { doc: page.id })).toMatchObject({ ok: false, message: expect.stringContaining("刷新") });
      const opened = new Y.Doc(), parts: Buffer[] = [];
      let answer = await bob.dispatch("read", { doc: page.id, offset: "0" }), windows = 0;
      for (;;) {
        if (!answer.ok) throw new Error(answer.message);
        const state = answer.result as unknown as DocumentState;
        parts.push(Buffer.from(state.update, "base64")); windows++;
        expect(Buffer.from(state.update, "base64").length).toBeLessThanOrEqual(window);
        if (state.next === null) break;
        answer = await bob.dispatch("read", { doc: page.id, snapshot: state.snapshot!, offset: String(state.next) });
      }
      expect(windows).toBeGreaterThan(25);
      Y.applyUpdate(opened, Buffer.concat(parts));
      expect(opened.getText("large").toString()).toBe(big.getText("large").toString());
      opened.destroy();
      big.destroy();
      const foreign = plane.documents.create(other, "alice", {
        request: "private",
        title: "另一空间",
      });
      expect(await alice.dispatch("read", { doc: foreign.id })).toMatchObject({
        ok: false,
      });
      expect(
        await bob.dispatch("comment", {
          doc: page.id,
          request: "comment",
          text: "独立成员的审阅意见",
        }),
      ).toMatchObject({ ok: true, result: { author: "bob" } });
      // Directory and discussion in cursor pages through the release's declared
      // params; an older View (no limit) still gets the whole list.
      const second = await alice.dispatch("create", { request: "acc-second", title: "第二页" });
      expect(second.ok).toBe(true);
      const walked: string[] = [];
      let cursor: string | null | undefined;
      do {
        const listed = await viewer.dispatch("library", { limit: "1", ...(cursor ? { after: cursor } : {}) });
        if (!listed.ok) throw new Error(listed.message);
        const { pages, next } = listed.result as unknown as LibraryPage;
        expect(pages).toHaveLength(1);
        walked.push(pages[0].id);
        cursor = next;
      } while (cursor);
      const legacyList = await viewer.dispatch("library");
      if (!legacyList.ok) throw new Error(legacyList.message);
      expect((legacyList.result as unknown as LibraryPage).pages.map((p) => p.id)).toEqual(walked);
      expect(walked).toHaveLength(2);
      expect(await viewer.dispatch("comments", { doc: page.id, limit: "200" })).toMatchObject({
        ok: true,
        result: { comments: [{ author: "bob", text: "独立成员的审阅意见" }], next: null },
      });
      expect(await viewer.dispatch("library", { limit: "1", after: "doc_unknown" })).toMatchObject({ ok: false });
      expect(
        await bob.dispatch("source", { project: sourceSpace }),
      ).toMatchObject({ ok: false });
      expect(
        (
          await alice.post("/api/permissions/grant", {
            subject_type: "app",
            subject_id: "research-v2",
            operations: ["read_project", "edit_graph"],
          })
        ).status,
      ).toBe(200);
      const node = (await source.invokeTool(
        { project: sourceSpace, actor: { kind: "human", owner: "alice" } },
        "node_add",
        {
          request: "docs-source",
          data: {
            type: "note",
            title: "原始研究笔记",
            data: { text: "这份正文仍属于原科研项目。" },
          },
        },
      )) as { node: { id: string } };
      expect(
        await alice.dispatch("source_call", {
          project: sourceSpace,
          action: "ref_describe",
          params: JSON.stringify({ ref: node.node.id }),
        }),
      ).toMatchObject({ ok: true, result: { status: "available" } });
      const binding = service.instances.resolve(
        alice.opened.handle,
        alice.principal,
      );
      if (!binding.ok) throw new Error("lost handle");
      const prior = plane.project(binding.binding, {}) as {
        docs: { sourceEpoch: number };
      };
      source.changed(sourceSpace);
      expect(plane.project(binding.binding, {})).toMatchObject({
        docs: { sourceEpoch: prior.docs.sourceEpoch + 1 },
      });
      if (process.env.RESEARCH_DOCS_BROWSER)
        await browserAcceptance({
          base,
          space,
          page: page.id,
          alice: alice.cookies,
          bob: bob.cookies,
          browser: process.env.RESEARCH_DOCS_BROWSER,
          artifacts:
            process.env.RESEARCH_DOCS_ARTIFACTS ?? join(root, "artifacts"),
        });
      expect(
        (
          await bob.post("/api/permissions/revoke", {
            subject_type: "app",
            subject_id: DOCS_APP,
          })
        ).status,
      ).toBe(200);
      expect(await bob.dispatch("read", { doc: page.id })).toMatchObject({
        ok: false,
      });
      store.removeSharedAppMember(DOCS_APP, space, "viewer");
      expect(await viewer.dispatch("read", { doc: page.id })).toMatchObject({
        ok: false,
      });
    } finally {
      await server.stop();
      service.stop();
      await composition.close();
      await supervisor.close();
      await state.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
