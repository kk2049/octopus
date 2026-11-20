/**
 * Agentic App release scopes: release inputs, focused tests, and the
 * single-App allowlists retained for historical `kind: app` tickets.
 *
 * Since #424 requesters no longer choose App versus full-system work. New
 * tickets are classified from their final diff by `delivery.ts`, which may
 * select several Apps when a shared untrusted View module fans out. The
 * original third kind remains as a compatibility contract for existing rows;
 * its safety argument is preserved below.
 *
 * ── Why the legacy third ticket kind existed ────────────────────────────────
 *
 * `simple` and `complex` differ only in prompt discipline — they buy the same
 * powers and pay the same price (a full-repo gate, several minutes of vitest,
 * and a merge lock held throughout). That is the right default for platform
 * work, where any file may legitimately be the one that has to change.
 *
 * An Agentic App is a different shape of work. Its whole design says so: the
 * View is compiled from module packages, the backend is declarative assets, the
 * result is an immutable release addressed by a package digest, and NOTHING it
 * contains is trusted code. A ticket that only rearranges those pieces cannot
 * break account isolation, cannot change what any capability answers, and
 * cannot reach the panel's route table — not because the agent promises not to,
 * but because the diff is checked against a path allowlist before it merges.
 *
 * So legacy `app` — and current `delivery=app_releases` — is the trade written
 * down: **more agile, in a smaller domain.**
 *
 *   · The restricted half is THIS table. An app ticket's diff may touch its
 *     App's packages and nothing else; one path outside and the merge is
 *     refused with a pointer at the ordinary ticket lane.
 *   · The agile half is the trimmed gate. Because the diff is PROVEN local to
 *     one App, the gate runs that App's vitest projects instead of the whole
 *     repository — minutes instead of ~21 of them — and the release pipeline
 *     re-derives every digest from the bytes afterwards anyway (it is
 *     fail-closed: a stale View build, a plan that does not link, a permission
 *     contract this build does not implement all refuse to pack or activate).
 *
 * The two halves are not independent: the agility is BOUGHT by the restriction.
 * Widening a scope entry therefore widens what a trimmed gate is allowed to
 * miss, which is why this table is explicit data with a stated criterion rather
 * than something derived from imports at runtime.
 *
 * ── The criterion for putting a path in a scope ─────────────────────────────
 *
 * A path belongs to an App's scope when **changing it changes only that App's
 * release**. Concretely, all three must hold:
 *
 *   1. its bytes are covered by that App's package digest (they are inputs to
 *      the View bundle, or they are backend release assets);
 *   2. nothing in the trusted bot process imports it — the bot may compute
 *      digests OVER these files, but must never `import` them;
 *   3. no OTHER App's release is compiled from it today.
 *
 * That third clause is why the shared foundations are deliberately ABSENT even
 * though the View bundle is compiled from them: `agent-view-react` (the SDK),
 * `agent-module-contract` (the module ABI), `workspace-files-contract`,
 * `resource-stream-contract`, `agent-sessions-contract`, `typed-port-kit` and
 * `web-trust` are all inputs to Session Plus's digest, and every one of them is
 * also the foundation the *next* App stands on. A trimmed gate that let those
 * through would be testing one App while changing all of them. (`web-trust` is
 * additionally a TCB path — see `TCB_PATHS` — so it is refused twice over, and
 * a test pins that no scope path ever overlaps that list.)
 *
 * Reusable View MODULE packages (`agent-sessions-view`, `agent-editor-view`, …)
 * are a judgement call rather than a law: they are reusable by design, so the
 * day a second App composes one of them it belongs to two scopes, and the
 * honest move then is to drop it out of both rather than to let an app ticket
 * for App A silently reshape App B. `sharedModulePackages()` computes exactly
 * that overlap so the test suite says it out loud the moment it appears.
 *
 * ── What this table is NOT ──────────────────────────────────────────────────
 *
 * Not a security boundary. The dev agent runs as the bot's own OS user with
 * `--dangerously-skip-permissions`; it could edit `bot.db` directly. This is the
 * same kind of object as `PROTECTED_PATHS` and `TCB_PATHS`: a DISCIPLINE gate
 * that makes a category of change take the lane that category was designed for,
 * and that leaves the decision recorded in the ticket conversation.
 *
 * Not a permission, either. Landing an app ticket republishes a release; it
 * grants that release nothing. A release whose permission contract changed still
 * needs every user to consent again, and that is a person's action on a page.
 */

/** One step of a gate run, as `execStep` in `pipeline.ts` executes it. */
export interface GateStep {
  bin: string;
  args: string[];
  timeoutMs: number;
}

export interface AppTicketScope {
  /** The stable app id — the same string `/apps` and the registry route by. */
  appId: string;
  /** Shown in the panel's picker and in every refusal message. */
  title: string;
  /**
   * Path prefixes this App's tickets may touch, relative to the repo root.
   * Directory entries end with "/" and match by prefix; the rest match exactly.
   */
  paths: readonly string[];
  /** Vitest projects that cover `paths`. Run with `--project <name>`. */
  projects: readonly string[];
  /**
   * Extra file/directory filters run inside the `node` project.
   *
   * These are TRUSTED-side suites, and they are in the gate precisely because
   * they are the fail-closed half: `packages/bot/src/app-registry` is where the
   * stale-View check, the release shape closed set and the digest coverage
   * matrix live, and `packages/bot/src/session-plus` is where this App's
   * identity and manifest equalities live. An app ticket cannot EDIT either
   * directory, but it can certainly break them.
   */
  nodePaths: readonly string[];
  /**
   * Every path whose bytes are INPUTS TO THIS APP'S RELEASE — a superset of
   * `paths`, and a different question from it (ticket #61).
   *
   * `paths` answers "may an app ticket edit this?" and is deliberately narrow:
   * the shared foundations are excluded because a trimmed gate must not be
   * allowed to change them. This list answers "does changing this produce a
   * different package digest?", and for that the foundations absolutely count —
   * they are compiled INTO the bundle. Editing one from an ordinary ticket is
   * legitimate and lands normally; what it also does is leave the App serving a
   * release that no longer matches the tree, which is exactly the surprise
   * ticket #61 was filed about.
   *
   * So this is what the pipeline reads to say "this landing owes a
   * republication", and `app-scopes.test.ts` pins it against the App's real
   * digest inputs (`*_VIEW_SOURCE`) so the two cannot drift.
   */
  releasePaths: readonly string[];
  /**
   * The workspace script that packs this App into an installable bundle, or
   * null when this build has no packer for it.
   *
   * Null is an honest answer, not a stub: a declared App's bytes arrive from
   * somewhere else entirely (somebody built and uploaded them), so there is no
   * "pack this checkout" for it and the pipeline reports that instead of
   * pretending a refresh happened.
   */
  packScript: string | null;
}

/**
 * Every App this repository can file an `app` ticket against.
 *
 * Adding an entry is a deliberate act with a written criterion (see the header),
 * not maintenance. `app-scopes.test.ts` checks the mechanical parts: every path
 * exists, no path collides with `TCB_PATHS`, every project is a real vitest
 * project, and no two scopes claim the same package.
 */
/** Shared packaging input: every packer embeds this exact View document shell. */
const SHARED_VIEW_RELEASE_PATHS = ["packages/bot/src/app-core/view-app.ts"] as const;

export const APP_TICKET_SCOPES: readonly AppTicketScope[] = [
  {
    appId: "session-plus",
    title: "会话+（Session Plus）",
    paths: [
      // The composition root: App.tsx, the adapter that owns every protocol
      // action string, the release plan, the chrome and the theme.
      "packages/session-plus-view/",
      // The research-program App now compiles the sessions/transcript and its
      // transitive file/Feishu presentation closure too. Those packages are
      // platform inputs and therefore belong to neither App's narrow lane.
      // The editor remains exclusive to Session Plus.
      "packages/agent-editor-view/",
      // The declarative, sandboxed backend: app.yaml, actions.ts, projection.ts
      // and the page declarations. These are release ASSETS — the trusted
      // process hashes them and materialises them for the App Runtime child,
      // and never imports them.
      "packages/bot/src/session-plus/app/",
    ],
    projects: [
      "session-plus-view",
      "agent-editor-view",
    ],
    nodePaths: ["packages/bot/src/session-plus", "packages/bot/src/app-registry"],
    // The source trees `SESSION_PLUS_VIEW_SOURCE` hashes (bundled packages plus
    // the build recipe in `agent-view-build`), plus the
    // declarative backend and the lockfile that pins the toolchain.
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/session-plus-view/",
      "packages/flight-recorder/",
      "packages/agent-sessions-view/",
      "packages/chat-ui-commons/",
      "packages/agent-sessions-contract/",
      "packages/agent-workspace-files-view/",
      "packages/agent-file-preview/",
      "packages/agent-editor-view/",
      "packages/agent-text-view/",
      "packages/agent-crdt-view/",
      "packages/agent-feishu-view/",
      "packages/workspace-files-contract/",
      "packages/crdt-doc-contract/",
      "packages/typed-port-kit/",
      "packages/resource-stream-contract/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "packages/bot/src/session-plus/app/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack",
  },
  {
    appId: "showcase",
    title: "模块演示（showcase）",
    paths: [
      // The composition root — and for this App that is nearly the whole thing:
      // `App.tsx` is one `<StandardApp>`, and the declarative backend
      // (`app/app.yaml`, `app/pages/`) lives under the same package, so the one
      // prefix covers both halves.
      "packages/showcase-view/",
      // `agent-data-view` used to be here, but Chess now composes it too. It is
      // still a release input below; it is no longer safe for either App's
      // trimmed ticket lane to claim a shared package as its own.
    ],
    projects: ["showcase-view"],
    // `app-registry` only: this App has no `packages/bot/src/<app>` of its own —
    // it is a DECLARED App, so the trusted side holds one row and one adapter
    // built from three fields, and everything that could break lives in the
    // registry (stale-View check, shape closed set, digest coverage).
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/showcase-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-deck-view/",
      "packages/deck-model-contract/",
      "packages/resource-stream-contract/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:showcase",
  },
  {
    appId: "ppt-studio",
    title: "PPT Studio",
    paths: ["packages/ppt-studio-view/"],
    projects: ["ppt-studio-view"],
    nodePaths: ["packages/bot/src/app-registry", "packages/bot/src/session-plus"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/ppt-studio-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-deck-view/",
      "packages/deck-model-contract/",
      "packages/resource-stream-contract/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:ppt-studio",
  },
  {
    appId: "chess",
    title: "国际象棋（chess）",
    paths: [
      // The declared App's composition, sandboxed backend assets and build
      // configuration all live together under this package.
      "packages/chess-view/",
      // The generic board module currently has Chess as its sole release
      // consumer. `agent-data-view` is deliberately absent: Showcase also
      // compiles it, so it belongs to neither App's narrow ticket allowlist.
      "packages/agent-board-view/",
    ],
    projects: ["chess-view", "agent-board-view"],
    // Chess is a declared App: the generic registry owns stale-View, release
    // shape and compatibility checks; there is no trusted chess adapter.
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/chess-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-board-view/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:chess",
  },
  {
    appId: "daily-brief",
    title: "日程总结（daily brief）",
    paths: ["packages/daily-brief-view/"],
    projects: ["daily-brief-view"],
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/daily-brief-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:daily-brief",
  },
  {
    appId: "meeting-room",
    title: "会议室预订（meeting room）",
    paths: ["packages/meeting-room-view/", "packages/agent-schedule-view/"],
    projects: ["meeting-room-view", "agent-schedule-view"],
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/meeting-room-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-schedule-view/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:meeting-room",
  },
  {
    appId: "expense-intake",
    title: "报销单处理（expense intake）",
    paths: ["packages/expense-intake-view/", "packages/agent-intake-view/"],
    projects: ["expense-intake-view", "agent-intake-view"],
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/expense-intake-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-intake-view/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:expense-intake",
  },
  {
    appId: "report-space",
    title: "汇报空间（report space）",
    paths: ["packages/report-space-view/"],
    projects: ["report-space-view"],
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/report-space-view/",
      "packages/flight-recorder/",
      "packages/agent-data-view/",
      "packages/agent-module-contract/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:report-space",
  },
  {
    appId: "research-program",
    title: "自动科研项目台（research program）",
    // Everything else in this bundle is now a shared platform package also
    // compiled by Session Plus. Only this declared App's composition,
    // sandboxed backend and build recipe belong to its narrow ticket lane.
    paths: ["packages/research-program-view/"],
    projects: ["research-program-view"],
    nodePaths: ["packages/bot/src/app-registry"],
    releasePaths: [
      ...SHARED_VIEW_RELEASE_PATHS,
      "packages/research-program-view/",
      "packages/flight-recorder/",
      "packages/agent-sessions-view/",
      "packages/agent-sessions-contract/",
      "packages/chat-ui-commons/",
      "packages/agent-feishu-view/",
      "packages/agent-workspace-files-view/",
      "packages/agent-file-preview/",
      "packages/agent-text-view/",
      "packages/agent-module-contract/",
      "packages/workspace-files-contract/",
      "packages/resource-stream-contract/",
      "packages/typed-port-kit/",
      "packages/agent-view-react/",
      "packages/web-trust/",
      "packages/agent-view-build/",
      "pnpm-lock.yaml",
    ],
    packScript: "app:pack:research-program",
  },
  {
    appId: 'research-v2', title: '自动科研 v2',
    paths: ['packages/research-canvas-view/'],
    projects: ['research-canvas-view'], nodePaths: ['packages/bot/src/research-canvas'],
    releasePaths: [...SHARED_VIEW_RELEASE_PATHS, 'packages/research-canvas-view/', 'packages/research-canvas-contract/',
      'packages/agent-sessions-view/', 'packages/agent-sessions-contract/', 'packages/chat-ui-commons/',
      'packages/agent-feishu-view/', 'packages/agent-workspace-files-view/', 'packages/agent-file-preview/', 'packages/agent-text-view/',
      'packages/agent-module-contract/', 'packages/workspace-files-contract/', 'packages/resource-stream-contract/',
      'packages/typed-port-kit/', 'packages/agent-view-react/', 'packages/flight-recorder/', 'packages/web-trust/', 'packages/agent-view-build/', 'pnpm-lock.yaml'],
    packScript: 'app:pack:research-v2',
  },
  {
    appId: 'research-docs', title: '研究文档',
    // The contract stays a release input but not an App-only path: the trusted
    // research-docs plane imports it, so a change needs a full deployment.
    paths: ['packages/research-docs-view/'],
    projects: ['research-docs-view'], nodePaths: ['packages/bot/src/research-docs'],
    releasePaths: [...SHARED_VIEW_RELEASE_PATHS, 'packages/research-docs-view/', 'packages/research-docs-contract/', 'packages/research-canvas-view/', 'packages/research-canvas-contract/', 'packages/agent-sessions-view/', 'packages/agent-sessions-contract/', 'packages/chat-ui-commons/', 'packages/agent-feishu-view/', 'packages/agent-workspace-files-view/', 'packages/agent-file-preview/', 'packages/agent-text-view/', 'packages/agent-module-contract/', 'packages/workspace-files-contract/', 'packages/resource-stream-contract/', 'packages/typed-port-kit/', 'packages/agent-view-react/', 'packages/flight-recorder/', 'packages/web-trust/', 'packages/agent-view-build/', 'pnpm-lock.yaml'],
    packScript: 'app:pack:research-docs',
  },
];

/** One scope by stable app id, or null when no such App can be ticketed. */
export function appScopeFor(appId: string | null | undefined): AppTicketScope | null {
  if (!appId) return null;
  return APP_TICKET_SCOPES.find((scope) => scope.appId === appId) ?? null;
}

/** The scope of a ticket row — null for `simple`/`complex` and unknown apps. */
export function scopeOfTicket(t: { kind?: string; app_id?: string | null }): AppTicketScope | null {
  return t.kind === "app" ? appScopeFor(t.app_id) : null;
}

/** The ids a panel picker may offer. */
export function appTicketChoices(): Array<{ id: string; title: string; refreshable: boolean }> {
  return APP_TICKET_SCOPES.map((scope) => ({
    id: scope.appId,
    title: scope.title,
    refreshable: scope.packScript != null,
  }));
}

/**
 * Directory entries (trailing "/") match by prefix; file entries match exactly.
 *
 * Identical to the rule `tcbPathHits` uses, and for the same reason: a raw
 * `startsWith` on a file entry would also claim `authz.tsx`, and a gate that
 * fires on files it was never asked about is a gate people learn to route
 * around. Shared here so the two gates cannot drift apart.
 */
export function pathMatches(file: string, pattern: string): boolean {
  return pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern;
}

/** Which of `files` fall OUTSIDE the App's scope. Empty = the diff is local. */
export function appScopeViolations(files: readonly string[], scope: AppTicketScope): string[] {
  return files.filter((f) => !scope.paths.some((p) => pathMatches(f, p)));
}

/**
 * Apps whose release these files change — the "you owe a republication" test.
 *
 * Deliberately independent of the ticket's kind: an ordinary ticket editing a
 * View module changes the App's digest just as much as an app ticket does, and
 * the whole point of ticket #61 is that nobody was told. Packable Apps only
 * (`packScript`): for a declared App whose bytes are built elsewhere there is
 * nothing this host could republish, so claiming it owes one would be a lie.
 */
export function appsWithReleaseChanges(
  files: readonly string[],
  scopes: readonly AppTicketScope[] = APP_TICKET_SCOPES,
): AppTicketScope[] {
  return scopes.filter(
    (scope) =>
      scope.packScript != null
      && files.some((file) => scope.releasePaths.some((p) => pathMatches(file, p))),
  );
}

/**
 * Packages claimed by more than one App scope.
 *
 * Empty today, and a test says so. When it stops being empty the trade this
 * file describes has quietly changed — an app ticket for App A would be able to
 * reshape App B under a gate that only ran App A's tests — so the answer is to
 * move the shared package OUT of both scopes (it has become platform), not to
 * relax the test.
 */
export function sharedModulePackages(scopes: readonly AppTicketScope[] = APP_TICKET_SCOPES): string[] {
  const seen = new Map<string, number>();
  for (const scope of scopes) {
    for (const p of scope.paths) seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p).sort();
}

/**
 * The vitest steps that stand in for the full suite on an app ticket.
 *
 * TWO commands, not one, and that is forced rather than stylistic: positional
 * path filters apply across every selected project, so
 * `--project session-plus-view --project node packages/bot/src/session-plus`
 * would filter the browser projects down to files that do not exist there and
 * silently run nothing. Selecting projects and filtering paths are therefore
 * separate runs.
 *
 * `--maxWorkers=1` for the same reason the full gate uses it: this host has two
 * cores shared with the production bot, and an uncapped run starves itself into
 * a cascade of 5s timeouts that reads as flaky tests rather than as contention.
 *
 * Budgets are per step. A trimmed run is minutes rather than the ~21 the full
 * suite takes, so 15 minutes is head-room for a loaded host and not an estimate.
 */
export const APP_GATE_VITEST_TIMEOUT_MS = 900_000;

export function appGateVitestSteps(scope: AppTicketScope): GateStep[] {
  const steps: GateStep[] = [];
  if (scope.projects.length > 0) {
    steps.push({
      bin: "npx",
      args: [
        "vitest",
        "run",
        "--maxWorkers=1",
        ...scope.projects.flatMap((project) => ["--project", project]),
      ],
      timeoutMs: APP_GATE_VITEST_TIMEOUT_MS,
    });
  }
  if (scope.nodePaths.length > 0) {
    steps.push({
      bin: "npx",
      args: ["vitest", "run", "--project", "node", "--maxWorkers=1", ...scope.nodePaths],
      timeoutMs: APP_GATE_VITEST_TIMEOUT_MS,
    });
  }
  return steps;
}
