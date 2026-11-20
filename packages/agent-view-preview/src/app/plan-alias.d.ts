/**
 * The preview entry imports the plan under a fixed specifier, and the dev
 * server aliases that specifier to whichever file the caller named.
 *
 * An alias rather than a generated entry file: nothing is written to disk, so a
 * preview leaves no artefact behind that a later build could pick up. This
 * declaration is what makes the same import typecheck under `tsc`.
 */

declare module "app-preview-plan" {
  const plan: import("../plan.js").PreviewPlan;
  export default plan;
}
