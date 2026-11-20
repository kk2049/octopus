/**
 * What a preview file is.
 *
 * ── Why a plan file rather than a config ────────────────────────────────────
 *
 * A draft View needs values a JSON config could not carry: either module
 * objects/adapters for a composition, or a render function for a bespoke App
 * root, plus a fixture projection. So a preview input is a small TypeScript
 * module that DEFAULT-EXPORTS one of these.
 *
 * A composition preview still runs through `StandardApp`. A custom preview
 * calls the same root render function the release entry calls. Neither profile
 * is translated into the other merely to fit this harness.
 *
 * ── What a preview is not ──────────────────────────────────────────────────
 *
 * It is not a deployment, an installation or an activation, and it touches
 * nothing in production. It also does not — and must not be extended to —
 * simulate approval, capability, identity or revocation. Connecting a draft to a
 * real development instance is explicitly future work; the value here is a
 * second-long loop that answers layout and configuration questions, and a
 * harness that blurred the line would answer authorisation questions wrongly.
 */

import type { ReactNode } from "react";
import type { AgentComposition, AgentResourceBindings } from "@claude-bot/agent-module-contract";
import type { AgentViewOperation, Projection } from "@claude-bot/agent-view-react";
import type { PortAdapterFactory, StandardAppProps } from "@claude-bot/agent-view-react/shell";
import type { ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import type { FixtureClientOptions } from "./fixture-client.js";

interface PreviewFixture {
  /** Shown in the document title and the preview banner. */
  title?: string;
  /** The boot frame the fixture client publishes. */
  projection?: Projection | null;
  operations?: readonly AgentViewOperation[];
  /** Canned answers per action id. An action with no entry is refused. */
  actions?: FixtureClientOptions["actions"];
}

export interface CompositionPreviewPlan extends PreviewFixture {
  /** Omitted for compatibility with existing preview plan files. */
  kind?: "composition";
  /** `agent-composition/v1` — the draft being looked at. */
  composition: AgentComposition;
  /** `agent-resource-bindings/v1`, when the draft depends on typed ports. */
  bindings?: AgentResourceBindings;
  modules: readonly ModuleRegistryEntry[];
  /** Contract id → adapter, one per binding. Usually a package's memory port. */
  adapters?: Readonly<Record<string, PortAdapterFactory>>;
  /** Contract id → adapter for the App's own projection and actions. */
  providers?: Readonly<Record<string, PortAdapterFactory>>;
  narrowPx?: number;
  /** Production shell presentation, so a Dock composition is previewed as Dock. */
  presentation?: StandardAppProps["presentation"];
  dock?: StandardAppProps["dock"];
  className?: string;
}

export interface CustomPreviewPlan extends PreviewFixture {
  kind: "custom";
  /** Stable App id, used only for the local document title. */
  app: string;
  /** Render the production App root inside the fixture-backed provider. */
  render(): ReactNode;
}

export type PreviewPlan = CompositionPreviewPlan | CustomPreviewPlan;

/**
 * Identity, for the types.
 *
 * A plan file writes `export default definePreviewPlan({…})` so its object
 * literal is checked where it is written rather than where it is imported — the
 * difference between "line 12 of your draft names a module that is not in the
 * list" and "something in the preview did not typecheck".
 */
export function definePreviewPlan(plan: CompositionPreviewPlan): CompositionPreviewPlan {
  return plan;
}

/** Identity helper for a bespoke publisher root. */
export function defineCustomPreview(plan: CustomPreviewPlan): CustomPreviewPlan {
  return plan;
}

export function previewTitle(plan: PreviewPlan): string {
  return plan.title ?? (plan.kind === "custom" ? plan.app : plan.composition.app);
}
