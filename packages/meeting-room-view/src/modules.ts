import type { ModuleRegistryEntry } from "@claude-bot/agent-view-react/workspace";
import { DATA_MODULES } from "@claude-bot/agent-data-view";
import { SCHEDULE_MODULES } from "@claude-bot/agent-schedule-view";

export const MEETING_ROOM_MODULES: readonly ModuleRegistryEntry[] = Object.freeze([...DATA_MODULES, ...SCHEDULE_MODULES]);
