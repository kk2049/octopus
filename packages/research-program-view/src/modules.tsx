/** Register the exact module objects used by Sessions+. */
import { SESSIONS_MODULES } from '@claude-bot/agent-sessions-view';
import { FILE_VIEWER_MODULE } from '@claude-bot/agent-workspace-files-view';
import { AGENT_CHAT_MODULE_ID } from '@claude-bot/agent-sessions-view/manifests';
export const RESEARCH_PROGRAM_MODULES = Object.freeze([
  ...SESSIONS_MODULES.filter(entry => entry.manifest.id === AGENT_CHAT_MODULE_ID),
  FILE_VIEWER_MODULE,
]);
