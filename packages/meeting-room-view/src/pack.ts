import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEETING_ROOM_APP, MEETING_ROOM_MANIFESTS, MEETING_ROOM_MODULE_ASSETS, MEETING_ROOM_PUBLISHER } from "./plan.js";
import { MEETING_ROOM_VIEW_BUILD_COMMAND, MEETING_ROOM_VIEW_DIST, MEETING_ROOM_VIEW_SOURCE } from "./paths.js";
export const MEETING_ROOM_TITLE = "会议室预订";
export default {
  app: MEETING_ROOM_APP, publisher: MEETING_ROOM_PUBLISHER, title: MEETING_ROOM_TITLE,
  appDir: resolve(dirname(fileURLToPath(import.meta.url)), "../app"), subdir: "packages/meeting-room-view",
  view: { distDir: MEETING_ROOM_VIEW_DIST, source: MEETING_ROOM_VIEW_SOURCE, buildCommand: MEETING_ROOM_VIEW_BUILD_COMMAND },
  manifests: MEETING_ROOM_MANIFESTS, moduleAssets: MEETING_ROOM_MODULE_ASSETS,
};
