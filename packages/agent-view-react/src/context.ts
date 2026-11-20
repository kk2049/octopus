/**
 * The context object, alone in a file so a Fast Refresh boundary never has to
 * choose between the provider component and the value it publishes.
 */

import { createContext } from "react";
import type { AgentViewClient, ProposalReply } from "./client.js";

export interface AgentViewContextValue {
  /** The transport. Apps rarely need it; hooks are the supported surface. */
  client: AgentViewClient;
  /**
   * Send one proposal and record its refusal, if any, as the notice below.
   * Never rejects — a refusal is an answer.
   */
  propose(action: string, params?: Record<string, string>): Promise<ProposalReply>;
  /** Bounded refusal text from the last proposal, or "" when there is none. */
  notice: string;
  clearNotice(): void;
}

export const AgentViewContext = createContext<AgentViewContextValue | null>(null);
