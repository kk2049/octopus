import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOT_PUBLISHABLE_SHARED_VIEW_PATHS,
  isAppOnlyPath,
  isHotPublishableAppPath,
  isNoRuntimePath,
  resolveDelivery,
  ticketCanUseAppWorktree,
  ticketNeedsTrustedDeploy,
} from "./delivery.js";
import { PROTECTED_PATHS, TCB_PATHS } from "./policy-paths.js";

const SIMPLE = { kind: "simple", app_id: null } as const;

describe("submit-time delivery classification", () => {
  it("keeps full_deploy conservative and none limited to documentation/test evidence", () => {
    expect(resolveDelivery(SIMPLE, ["packages/bot/src/index.ts"], { mode: "full_deploy" }))
      .toMatchObject({ ok: true, plan: { mode: "full_deploy", apps: [] } });
    expect(resolveDelivery(SIMPLE, ["doc/runbooks/example.md", "packages/bot/src/x.test.ts"], { mode: "none" }))
      .toMatchObject({ ok: true, plan: { mode: "none", apps: [] } });

    const sourceAsNone = resolveDelivery(SIMPLE, ["packages/bot/src/index.ts"], { mode: "none" });
    expect(sourceAsNone).toMatchObject({ ok: false, files: ["packages/bot/src/index.ts"] });
    expect(resolveDelivery(SIMPLE, ["packages/agent-data-view/README.md"], { mode: "none" }))
      .toMatchObject({ ok: false, files: ["packages/agent-data-view/README.md"] });
    expect(isNoRuntimePath("packages/bot/README.md")).toBe(true);
    expect(isNoRuntimePath("packages/bot/src/index.ts")).toBe(false);
  });

  it("requires the exact complete App set for a shared View module", () => {
    const file = "packages/agent-data-view/src/modules.tsx";
    const exact = [
      "chess",
      "daily-brief",
      "expense-intake",
      "meeting-room",
      "ppt-studio",
      "report-space",
      "showcase",
    ];
    const accepted = resolveDelivery(SIMPLE, [file], { mode: "app_releases", apps: exact });
    expect(accepted).toMatchObject({ ok: true, plan: { mode: "app_releases" } });
    if (accepted.ok) {
      expect(accepted.plan.apps.map((app) => app.appId)).toEqual(exact);
      expect(accepted.plan.tests).toContain("project:agent-data-view");
      expect(accepted.plan.tests).toContain("project:chess-view");
      expect(accepted.plan.tests).toContain("project:showcase-view");
      expect(accepted.plan.tests).toContain("packages/bot/src/app-registry");
    }

    expect(resolveDelivery(SIMPLE, [file], { mode: "app_releases", apps: ["showcase"] }))
      .toMatchObject({ ok: false });
    expect(resolveDelivery(SIMPLE, [file], { mode: "app_releases", apps: [...exact, "session-plus"] }))
      .toMatchObject({ ok: false });
  });

  it("does not confuse every release digest input with hot-publishable View bytes", () => {
    const allApps = [
      "chess", "daily-brief", "expense-intake", "meeting-room", "ppt-studio",
      "report-space", "research-docs", "research-program", "research-v2", "session-plus", "showcase",
    ];
    for (const file of [
      "packages/bot/src/app-core/view-app.ts",
      "packages/web-trust/src/gate.ts",
      "packages/web-trust/src/gate.test.ts",
      "packages/agent-module-contract/src/index.ts",
      "packages/agent-view-build/src/build.ts",
      "pnpm-lock.yaml",
    ]) {
      const result = resolveDelivery(SIMPLE, [file], { mode: "app_releases", apps: allApps });
      expect(result, file).toMatchObject({ ok: false, files: [file] });
    }
    expect(resolveDelivery(SIMPLE, ["packages/agent-view-react/src/client.ts"], {
      mode: "app_releases",
      apps: allApps,
    })).toMatchObject({ ok: true });
  });

  it("pins every shared hot path outside protected and trusted-boundary prefixes", () => {
    for (const { path } of HOT_PUBLISHABLE_SHARED_VIEW_PATHS) {
      expect(isHotPublishableAppPath(`${path}src/index.ts`), path).toBe(true);
      expect(PROTECTED_PATHS.some((protectedPath) => path.startsWith(protectedPath)), path).toBe(false);
      expect(TCB_PATHS.some((trustedPath) => path.startsWith(trustedPath)), path).toBe(false);
    }
  });

  it("keeps packages the trusted bot imports at runtime out of the App-only boundary", () => {
    // App-only changes go live without a bot deployment (#61), so a package
    // the bot itself imports must never count as App-only. The two App
    // composition packages are read only for their release plan and paths.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const dirs = new Map<string, string>();
    for (const dir of readdirSync(join(repoRoot, "packages"))) {
      const manifest = join(repoRoot, "packages", dir, "package.json");
      if (existsSync(manifest)) dirs.set((JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name, dir);
    }
    const bot = JSON.parse(readFileSync(join(repoRoot, "packages", "bot", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const appOnly = Object.keys(bot.dependencies)
      .flatMap((name) => dirs.has(name) ? [`packages/${dirs.get(name)}/src/index.ts`] : [])
      .filter((file) => isAppOnlyPath(file));
    expect(appOnly).toEqual([
      "packages/session-plus-view/src/index.ts",
      "packages/showcase-view/src/index.ts",
    ]);
    expect(isAppOnlyPath("packages/research-docs-contract/src/index.ts")).toBe(false);
    expect(isAppOnlyPath("packages/research-docs-view/src/App.tsx")).toBe(true);
  });

  it("preserves old rows while letting new App-only rows bypass trusted deploy", () => {
    expect(ticketNeedsTrustedDeploy({ kind: "simple", delivery_mode: null })).toBe(true);
    expect(ticketNeedsTrustedDeploy({ kind: "app", delivery_mode: null })).toBe(false);
    expect(ticketNeedsTrustedDeploy({ kind: "simple", delivery_mode: "app_releases" })).toBe(false);
    expect(ticketNeedsTrustedDeploy({ kind: "app", delivery_mode: "full_deploy" })).toBe(true);

    expect(ticketCanUseAppWorktree({
      kind: "simple",
      app_id: null,
      delivery_mode: "app_releases",
      delivery_apps: JSON.stringify(["showcase", "ppt-studio"]),
    }, "ppt-studio")).toBe(true);
  });
});
