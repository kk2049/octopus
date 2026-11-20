/**
 * Sessions chrome a composition mounts OUTSIDE the workspace.
 *
 * ── Why this is not a module (ticket #189) ─────────────────────────────────
 *
 * A module is something the layout kernel mounts into a slot. This is a button
 * for the App's own frame — the phone bar the workbench paints above every
 * layer — so it has no manifest, no slot, and no resource. What it does have is
 * the same port every module has: it reads the controller from context and
 * proposes exactly the reads the rail's own ↻ proposes.
 *
 * The phone had no refresh at all. The rail's manual ↻ stands down on a narrow
 * viewport (ticket #181) because the index re-lists on mount and on every
 * Runner wake, which is true and was still the wrong conclusion: "it will
 * refresh itself eventually" is not an answer to somebody looking at a stale
 * list right now. Putting it in the frame instead of back in the rail is what
 * makes it reachable from the chat layer too, where the rail is not on screen.
 */

import { AvButton } from "@claude-bot/agent-view-react/ui";
import { useOptionalWorkspaceFiles } from "@claude-bot/agent-workspace-files-view";
import { useSessions } from "./context.js";
import { TRANSCRIPT_PAGE } from "./lib/projection.js";

export interface SessionsRefreshActionProps {
  /** Optional DOM id for compatibility; tests use the stable data action. */
  id?: string;
  /** Bounded label. A glyph by default: the phone bar has four other controls. */
  label?: string;
}

/**
 * Refresh everything this App can currently be looking at.
 *
 * One gesture, four reads, and no speculation: the roster, the per-device
 * workspace lists, the file roots, and — only when a session is selected — that
 * session's tail window. Each is a capability call the Host decides on as
 * usual; none is retried, and none is issued for a surface that is not bound.
 */
export function SessionsRefreshAction({
  id = "mobileRefresh",
  label = "↻",
}: SessionsRefreshActionProps = {}) {
  const sessions = useSessions();
  const files = useOptionalWorkspaceFiles();
  return (
    <AvButton
      id={id}
      className="av-refresh-action"
      data-av-session-action="refresh"
      title="刷新会话列表、工作区与当前会话"
      aria-label="刷新"
      onClick={() => {
        sessions.refresh();
        sessions.requestWorkspaces(true);
        // Single-flight inside the provider: a refresh while one is in flight
        // joins it rather than buying a second approval card.
        files?.refreshRoots();
        if (sessions.selected) sessions.read(sessions.selected, TRANSCRIPT_PAGE);
      }}
    >
      {label}
    </AvButton>
  );
}
