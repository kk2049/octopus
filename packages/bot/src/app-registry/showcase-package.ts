/**
 * The showcase App's pack config — everything app-specific about building one
 * `showcase` release out of this checkout.
 *
 * The mechanics (View loading, backend bundling, shape and plan checks,
 * `describeRelease`) live once in `app-package.ts`; what remains here is the
 * data that makes those mechanics produce THIS app. The original argument for
 * why a declared App has a packer in this repository at all — and why that
 * packer is not privileged — is in `app-package.ts`'s header; it applied to
 * every app, which is exactly why it moved.
 */

import { fileURLToPath } from "node:url";
import {
  SHOWCASE_APP,
  SHOWCASE_MANIFESTS,
  SHOWCASE_MODULE_ASSETS,
  SHOWCASE_PUBLISHER,
} from "@claude-bot/showcase-view/plan";
import {
  SHOWCASE_VIEW_BUILD_COMMAND,
  SHOWCASE_VIEW_DIST,
  SHOWCASE_VIEW_SOURCE,
} from "@claude-bot/showcase-view";
import { buildAppBundle, packApp, type AppPackConfig } from "./app-package.js";
import type { PackageAsset } from "../app-core/view-app.js";
import type { ReleaseBundle } from "./bundle.js";

/** Where the showcase App's four backend files live in this checkout. */
export const SHOWCASE_APP_DIR = fileURLToPath(
  new URL("../../../showcase-view/app/", import.meta.url),
);

/** Human title for the declaration this release belongs to. */
export const SHOWCASE_TITLE = "模块演示";

/** The whole of this app's packer, as data. */
export const SHOWCASE_PACK: AppPackConfig = {
  app: SHOWCASE_APP,
  publisher: SHOWCASE_PUBLISHER,
  title: SHOWCASE_TITLE,
  appDir: SHOWCASE_APP_DIR,
  subdir: "packages/showcase-view",
  view: {
    distDir: SHOWCASE_VIEW_DIST,
    source: SHOWCASE_VIEW_SOURCE,
    buildCommand: SHOWCASE_VIEW_BUILD_COMMAND,
  },
  manifests: SHOWCASE_MANIFESTS,
  moduleAssets: SHOWCASE_MODULE_ASSETS,
};

/** The nine named assets, in inventory order. */
export async function showcasePackage(): Promise<{ assets: readonly PackageAsset[] }> {
  return packApp(SHOWCASE_PACK);
}

/** Describe the showcase release this checkout would publish. */
export async function buildShowcaseBundle(
  options: { builder?: string; statement?: string } = {},
): Promise<ReleaseBundle> {
  return buildAppBundle(SHOWCASE_PACK, options);
}
