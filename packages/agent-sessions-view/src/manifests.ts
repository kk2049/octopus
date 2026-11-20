/**
 * The seven sessions manifests, as pure data.
 *
 * Separated from the components so that something with no DOM can read them: a
 * release builder has to emit the module lock as a JSON asset, and it runs in a
 * Node process that has no business importing React or a stylesheet.
 *
 * The split is also what makes the lock trustworthy. `modules.tsx` pairs each of
 * these with its component, and the registry derives the lock from the manifests
 * it was actually given — so the file a release ships and the objects that can
 * mount come from one statement, not two that happen to agree.
 */

import type { AgentModuleManifest, ModuleConfigDeclaration } from "@claude-bot/agent-module-contract";
import { AGENT_SESSIONS_CONTRACT } from "@claude-bot/agent-sessions-contract";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V3,
  WORKSPACE_FILES_CONTRACT_V4,
} from "@claude-bot/workspace-files-contract";

/** The version every sessions module in this package ships at. */
const VERSION = "1.2.0";
const PACKAGE = "@claude-bot/agent-sessions-view";

/**
 * The synthetic resource the new-agent form is opened as.
 *
 * A deliberate use of the ONE opening mechanism rather than a second one: the
 * roster's `＋` fills the draft and raises `open-resource/v1`, the coordinator
 * applies the same reuse rule it applies to a session (clicking `＋` twice
 * focuses the form instead of stacking two forms), and closing it is closing a
 * panel. A private "is the form open" flag inside a module would have been a
 * second layout system.
 */
export const NEW_SESSION_RESOURCE = Object.freeze({
  kind: "new-session",
  ref: "draft",
  label: "启动新的本地 Agent",
});

/**
 * A terminal tab is keyed by the projected physical device id. The value is
 * display/resource identity inside this View only; the trusted Host still
 * resolves the device and registered workspace again for every proposal.
 */
export const REMOTE_TERMINAL_RESOURCE_KIND = "remote-terminal";

export const SESSION_SEARCH_MODULE_ID = "session.search/v1";
export const SESSION_ROSTER_MODULE_ID = "session.roster-tree/v1";
export const SESSION_DIRECTORY_INDEX_MODULE_ID = "session.directory-index/v1";
export const AGENT_CHAT_MODULE_ID = "agent.chat/v1";
export const NEW_SESSION_MODULE_ID = "session.new/v1";
export const SESSION_OPERATIONS_MODULE_ID = "session.operations/v1";
export const REMOTE_TERMINAL_MODULE_ID = "session.remote-terminal/v1";

export const SESSION_SEARCH_MANIFEST: AgentModuleManifest = {
  id: SESSION_SEARCH_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#SessionSearch`,
  title: "搜索",
  slots: ["navigation"],
  ports: [AGENT_SESSIONS_CONTRACT],
  opens: [],
};

export const SESSION_ROSTER_MANIFEST: AgentModuleManifest = {
  id: SESSION_ROSTER_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#SessionRoster`,
  title: "会话",
  slots: ["navigation"],
  ports: [AGENT_SESSIONS_CONTRACT],
  opens: [],
};

/**
 * What a directory-index instance accepts from its composition: which module
 * opens a file for EDITING. The same single key the standalone file tree
 * declares, for the same reason — this package never names an editor; the
 * composition does, in one reviewable line.
 */
export const SESSION_DIRECTORY_INDEX_CONFIG: ModuleConfigDeclaration = Object.freeze({
  edit_view: {
    type: "string",
    description: "点「编辑」时打开哪个模块的 id（留空则不显示编辑按钮）",
  },
});

/**
 * The file-centred index: a lazy workspace file tree whose directory session
 * entries join by `directoryKey` equality. Without a files binding it degrades
 * to the roster's device → cwd tree.
 *
 * It declares BOTH port families because it reads both projections: sessions
 * through `agent-sessions/v1`, and — when the composition wires a files
 * binding — the lazy directory layer through any supported `workspace-files`
 * contract version. Without a files port it renders the sessions tree alone,
 * which is the honest degraded form, not an error.
 */
export const SESSION_DIRECTORY_INDEX_MANIFEST: AgentModuleManifest = {
  id: SESSION_DIRECTORY_INDEX_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#DirectoryIndex`,
  title: "导航",
  slots: ["navigation"],
  ports: [
    AGENT_SESSIONS_CONTRACT,
    WORKSPACE_FILES_CONTRACT,
    WORKSPACE_FILES_CONTRACT_V2,
    WORKSPACE_FILES_CONTRACT_V3,
    WORKSPACE_FILES_CONTRACT_V4,
  ],
  config: SESSION_DIRECTORY_INDEX_CONFIG,
  // It opens nothing itself: it RAISES `open-resource/v1`, and the composition
  // decides which module answers.
  opens: [],
};

export const AGENT_CHAT_MANIFEST: AgentModuleManifest = {
  id: AGENT_CHAT_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#AgentChat`,
  title: "会话正文",
  slots: ["primary", "secondary"],
  ports: [AGENT_SESSIONS_CONTRACT],
  opens: ["session"],
};

export const NEW_SESSION_MANIFEST: AgentModuleManifest = {
  id: NEW_SESSION_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#NewSession`,
  title: "启动新的本地 Agent",
  slots: ["secondary", "primary"],
  ports: [AGENT_SESSIONS_CONTRACT],
  opens: ["new-session"],
};

export const SESSION_OPERATIONS_MANIFEST: AgentModuleManifest = {
  id: SESSION_OPERATIONS_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#SessionOperations`,
  title: "提交状态",
  slots: ["bottom"],
  ports: [AGENT_SESSIONS_CONTRACT],
  opens: [],
};

export const REMOTE_TERMINAL_MANIFEST: AgentModuleManifest = {
  id: REMOTE_TERMINAL_MODULE_ID,
  version: VERSION,
  implementation: `${PACKAGE}#RemoteTerminal`,
  title: "远端终端",
  slots: ["primary", "secondary"],
  ports: [AGENT_SESSIONS_CONTRACT],
  opens: [REMOTE_TERMINAL_RESOURCE_KIND],
};

/** Every sessions manifest, in registration order. */
export const SESSIONS_MANIFESTS: readonly AgentModuleManifest[] = Object.freeze([
  SESSION_SEARCH_MANIFEST,
  SESSION_ROSTER_MANIFEST,
  SESSION_DIRECTORY_INDEX_MANIFEST,
  AGENT_CHAT_MANIFEST,
  NEW_SESSION_MANIFEST,
  SESSION_OPERATIONS_MANIFEST,
  REMOTE_TERMINAL_MANIFEST,
]);
