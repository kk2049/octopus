/**
 * `@claude-bot/agent-view-preview` — the local draft-composition harness.
 *
 * A separate package so a released bundle cannot pick it up by reaching for the
 * obvious import. What is here answers its own proposals out of a fixture, and a
 * View that shipped with it compiled in would be talking to itself.
 */

export {
  createFixtureAgentViewClient,
  type FixtureAgentViewClient,
  type FixtureAnswer,
  type FixtureClientOptions,
} from "./fixture-client.js";

export {
  defineCustomPreview,
  definePreviewPlan,
  previewTitle,
  type CompositionPreviewPlan,
  type CustomPreviewPlan,
  type PreviewPlan,
} from "./plan.js";
