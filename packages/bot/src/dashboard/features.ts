/**
 * Configuration features that can make dashboard routes exist or disappear.
 *
 * These are composition facts, not permissions. A disabled feature answers
 * 404; an enabled feature still goes through the route's normal Cedar action.
 * Keeping the registry as data prevents every optional App from adding another
 * `needsFoo` boolean to the router and another `fooTab` parameter to every page.
 */
export const PANEL_FEATURE = {
  devPipeline: "dev-pipeline",
  sessionPlus: "session-plus",
  /**
   * The Agentic App release registry and its local management page.
   *
   * Separate from `session-plus` on purpose: the App is a product feature a
   * deployment turns on for its users, while the registry is the operator's
   * control over which release that App runs. A composition can serve the
   * management page for an app whose feature is currently deactivated — that is
   * exactly the state an operator has to be able to get out of.
   */
  appRegistry: "app-registry",
  /** The first-party research workbench is declared on this host. */
  researchProgram: "research-program",
  researchCanvas: 'research-v2',
  /**
   * The architecture observatory: a read-only projection of the analyzer's
   * atlas snapshot plus a single-slot re-analysis job. Present only when the
   * composition constructed an `ArchitectureService` — the snapshot describes
   * this checkout, so a composition without one has nothing to serve.
   */
  architecture: "architecture",
  /**
   * The knowledge wiki: a read-only projection of the derived development
   * knowledge graph plus the reviewer's decision ledger. Present only when the
   * composition constructed a `KnowledgeWikiService` (it reads the graph the
   * dev pipeline builds under the data dir).
   */
  knowledge: "knowledge",
} as const;

export type PanelFeature = (typeof PANEL_FEATURE)[keyof typeof PANEL_FEATURE];
export type EnabledPanelFeatures = readonly PanelFeature[];

const DISABLED_MESSAGE: Readonly<Record<PanelFeature, string>> = {
  [PANEL_FEATURE.devPipeline]: "self-hosting pipeline disabled",
  [PANEL_FEATURE.sessionPlus]: "session plus disabled",
  [PANEL_FEATURE.appRegistry]: "app release registry disabled",
  [PANEL_FEATURE.researchProgram]: "research program app is not declared",
  [PANEL_FEATURE.researchCanvas]: 'research v2 app is not declared',
  [PANEL_FEATURE.architecture]: "architecture observatory disabled",
  [PANEL_FEATURE.knowledge]: "knowledge wiki disabled",
};

export function featureEnabled(
  enabled: EnabledPanelFeatures | undefined,
  feature: PanelFeature,
): boolean {
  return enabled?.includes(feature) ?? false;
}

export function featureDisabledMessage(feature: PanelFeature): string {
  return DISABLED_MESSAGE[feature];
}
