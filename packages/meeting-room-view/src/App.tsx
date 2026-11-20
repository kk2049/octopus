import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { MEETING_ROOM_COMPOSITION } from "./plan.js";
import { MEETING_ROOM_MODULES } from "./modules.js";

const PROVIDERS = Object.freeze({ [APP_DATA_CONTRACT]: appDataAdapter });
export function App() {
  return <StandardApp composition={MEETING_ROOM_COMPOSITION} modules={MEETING_ROOM_MODULES} providers={PROVIDERS}
    className="meeting-room" backLabel="返回会议室"
    header={<div className="meeting-head"><b>会议室</b><span>三间房 · 整点时段 · 人和 Agent 使用同一套防冲突动作</span></div>} />;
}
