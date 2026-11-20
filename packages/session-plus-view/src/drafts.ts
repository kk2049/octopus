/** Browser-local draft adapter owned by the App composition boundary. */

import type { AgentViewClient } from "@claude-bot/agent-view-react";
import {
  NEW_SESSION_PROMPT_DRAFT_RESOURCE,
  type ComposerDraftPersistence,
} from "@claude-bot/agent-sessions-view";

const CHAT_PREFIX = "session-chat:";
const NEW_SESSION_PROMPT_KEY = "session-new:prompt";

export function createSessionComposerDraftPersistence(
  client: AgentViewClient,
): ComposerDraftPersistence {
  const key = (resource: string): string => resource === NEW_SESSION_PROMPT_DRAFT_RESOURCE
    ? NEW_SESSION_PROMPT_KEY
    : `${CHAT_PREFIX}${resource}`;
  return {
    get: (resource) => client.drafts.get(key(resource)),
    set: (resource, text) => client.drafts.set(key(resource), text),
    subscribe: (resource, listener) => client.drafts.subscribe(key(resource), listener),
  };
}

/** The Host scopes this display preference to the current browser/account. */
export function createAsyncQuestionPersistence(client: AgentViewClient): ComposerDraftPersistence {
  const key = (resource: string): string => `session-async-ignored:${resource}`;
  return {
    get: (resource) => client.drafts.get(key(resource)),
    set: (resource, text) => client.drafts.set(key(resource), text),
    subscribe: (resource, listener) => client.drafts.subscribe(key(resource), listener),
  };
}
