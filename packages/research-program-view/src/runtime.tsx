import { createContext, useContext, useEffect, useMemo, useRef, type PropsWithChildren } from "react";
import type { ProposalReply } from "@claude-bot/agent-view-react";
import type { ResearchProjection } from "./model.js";

export interface ResearchProgramRuntime {
  operations?: import('@claude-bot/agent-sessions-contract').SessionOperation[];
  projection: ResearchProjection;
  channelOpen: boolean;
  propose(action: string, params?: Record<string, string>): Promise<ProposalReply>;
}

import { SessionsProvider } from '@claude-bot/agent-sessions-view';
import { WorkspaceFilesProvider } from '@claude-bot/agent-workspace-files-view';
import { createResearchSessionsAdapter, researchSessionScope } from './sessions-adapter.js';
import { createResearchFileLinks } from './file-links.js';
import { createResearchDocumentsAdapter } from './documents-adapter.js';
import { defaultSessionKey } from './model.js';

const RuntimeContext = createContext<ResearchProgramRuntime | null>(null);

export function ResearchProgramProvider({ value, children }: PropsWithChildren<{ value: ResearchProgramRuntime }>) {
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useResearchProgram(): ResearchProgramRuntime {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("research program module requires ResearchProgramProvider");
  return value;
}

export function ResearchResourcesProvider({ value, children }: PropsWithChildren<{ value: ResearchProgramRuntime }>) {
  const current = useRef(value); current.current = value;
  const adapters = useMemo(() => {
    const propose: ResearchProgramRuntime['propose'] = (...args) => current.current.propose(...args);
    return { links: createResearchFileLinks(() => current.current.projection), files: createResearchDocumentsAdapter(() => current.current.projection, propose) };
  }, []);
  const scope = researchSessionScope(value.projection, value.channelOpen);
  const sessions = useMemo(() => createResearchSessionsAdapter((...args) => current.current.propose(...args)), [scope]);
  useEffect(() => sessions.update(value.projection, value.channelOpen, value.operations), [sessions, value.projection, value.channelOpen, value.operations]);
  useEffect(() => () => sessions.update({}, false), [sessions]);
  return <ResearchProgramProvider value={value}><SessionsProvider key={scope} port={sessions.port} initialSelectedResource={defaultSessionKey(value.projection)}><WorkspaceFilesProvider port={adapters.files} links={adapters.links}>{children}</WorkspaceFilesProvider></SessionsProvider></ResearchProgramProvider>;
}
