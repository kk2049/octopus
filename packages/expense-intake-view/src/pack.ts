import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPENSE_INTAKE_VIEW_BUILD_COMMAND, EXPENSE_INTAKE_VIEW_DIST, EXPENSE_INTAKE_VIEW_SOURCE } from "./paths.js";
export const EXPENSE_INTAKE_APP = "expense-intake";
export const EXPENSE_INTAKE_PUBLISHER = "octopus:first-party";
export const EXPENSE_INTAKE_TITLE = "报销单处理";
export default {
  app: EXPENSE_INTAKE_APP,
  publisher: EXPENSE_INTAKE_PUBLISHER,
  title: EXPENSE_INTAKE_TITLE,
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"),
  subdir: "packages/expense-intake-view",
  view: {
    distDir: EXPENSE_INTAKE_VIEW_DIST,
    source: EXPENSE_INTAKE_VIEW_SOURCE,
    buildCommand: EXPENSE_INTAKE_VIEW_BUILD_COMMAND,
  },
};
