import { agentViewViteConfig } from "@claude-bot/agent-view-build";
import { MEETING_ROOM_VIEW_SOURCE } from "./src/paths";
export default agentViewViteConfig({ appId: "meeting-room", entry: "src/main.tsx", globalName: "MeetingRoomView", source: MEETING_ROOM_VIEW_SOURCE });
