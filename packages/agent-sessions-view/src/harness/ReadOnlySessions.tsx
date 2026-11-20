import { AvButton } from "@claude-bot/agent-view-react/ui";
/**
 * The second App: a read-only sessions browser.
 *
 * ── What it proves ──────────────────────────────────────────────────────────
 *
 * That the modules are reusable, in the only way that claim can be checked: a
 * different composition, a different provider, no Session Plus anywhere, and the
 * SAME search, roster and chat implementations — not copies of them.
 *
 * Its composition is genuinely different, which is the point:
 *
 *   · three modules instead of five — no new-agent form, no submission strip,
 *     because a read-only viewer has nothing to submit;
 *   · the chat in `primary` with a `session` open rule, so a search hit or a
 *     roster row still opens the transcript beside the rail;
 *   · a port whose four write methods refuse.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 *
 * Not a production route, not a release, and not a second publisher. It is a
 * harness: something a person can render, and something the test suite renders
 * to check that "reusable" is a property of the code rather than a paragraph.
 */

import { useMemo } from "react";
import { COMPOSITION_SCHEMA, type AgentComposition } from "@claude-bot/agent-module-contract";
import type { SessionsPort } from "@claude-bot/agent-sessions-contract";
import { Banner } from "@claude-bot/agent-view-react/ui";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspaceLayout,
} from "@claude-bot/agent-view-react/workspace";
import { SessionsProvider, useSessions } from "../context.js";
import {
  AGENT_CHAT_MANIFEST,
  AGENT_CHAT_MODULE_ID,
  SESSION_ROSTER_MANIFEST,
  SESSION_ROSTER_MODULE_ID,
  SESSION_SEARCH_MANIFEST,
  SESSION_SEARCH_MODULE_ID,
} from "../manifests.js";
import { SESSIONS_MODULES } from "../modules.js";

/** Exactly the three modules a read-only browser needs. */
const READ_ONLY_MODULE_IDS = new Set([
  SESSION_SEARCH_MANIFEST.id,
  SESSION_ROSTER_MANIFEST.id,
  AGENT_CHAT_MANIFEST.id,
]);

export const READ_ONLY_COMPOSITION: AgentComposition = Object.freeze<AgentComposition>({
  schema: COMPOSITION_SCHEMA,
  app: "sessions-read-only",
  instances: [
    { instance: "search", module: SESSION_SEARCH_MODULE_ID, slot: "navigation" },
    { instance: "roster", module: SESSION_ROSTER_MODULE_ID, slot: "navigation" },
    { instance: "chat", module: AGENT_CHAT_MODULE_ID, slot: "primary", title: "只读会话正文" },
  ],
  open: [{ resource: "session", module: AGENT_CHAT_MODULE_ID, slot: "primary" }],
});

export interface ReadOnlySessionsProps {
  port: SessionsPort;
}

export function ReadOnlySessionsApp({ port }: ReadOnlySessionsProps) {
  const plan = useMemo(
    () =>
      createWorkspacePlan({
        composition: READ_ONLY_COMPOSITION,
        // The SAME module objects the production App registers, filtered to the
        // three this composition mounts. Rebuilding them here from the same
        // components would be a second registry that could drift.
        registry: createModuleRegistry(SESSIONS_MODULES.filter((entry) => READ_ONLY_MODULE_IDS.has(entry.manifest.id))),
      }),
    [],
  );
  return (
    <SessionsProvider port={port}>
      <ReadOnlyNotice />
      <ReadOnlyWorkspace plan={plan} />
    </SessionsProvider>
  );
}

/**
 * The refusal, shown.
 *
 * A read-only App that swallowed the provider's answer would look broken rather
 * than read-only — the composer would clear and nothing would happen. This is
 * also the one consumer of `clearRefusal()`: the notice is dismissable, because
 * unlike the trusted Host's channel there is no "next proposal" that would clear
 * it on its own.
 */
function ReadOnlyNotice() {
  const sessions = useSessions();
  if (!sessions.refusal) return null;
  // The SDK's primitive rather than a class name: a harness that styled itself
  // with the production App's theme would be borrowing the thing it is supposed
  // to be independent of.
  return (
    <Banner icon="⊘" tone="warn" title="只读" text={sessions.refusal}>
      <AvButton onClick={sessions.clearRefusal}>知道了</AvButton>
    </Banner>
  );
}

function ReadOnlyWorkspace({ plan }: { plan: ReturnType<typeof createWorkspacePlan> }) {
  const { state, api } = useWorkspaceLayout(plan);
  return (
    <WorkspaceShell
      plan={plan}
      state={state}
      api={api}
      className="cols"
      chrome={{ navigation: { className: "side card" }, primary: { className: "main card" } }}
    />
  );
}
