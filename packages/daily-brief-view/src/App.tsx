import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { DAILY_BRIEF_COMPOSITION } from "./plan.js";
import { DAILY_BRIEF_MODULES } from "./modules.js";

const PROVIDERS = Object.freeze({ [APP_DATA_CONTRACT]: appDataAdapter });

export function App() {
  return (
    <StandardApp
      composition={DAILY_BRIEF_COMPOSITION}
      modules={DAILY_BRIEF_MODULES}
      providers={PROVIDERS}
      presentation="dock-documents"
      className="daily-brief"
      backLabel="返回总结"
      dock={{ surfaceClassName: { navigation: "brief-fixed-rail", bottom: "brief-fixed-actions", primary: "brief-document" } }}
      header={
        <div className="brief-head">
          <div><span className="brief-kicker">PERSONAL INTELLIGENCE</span><b>日程总结</b></div>
          <span>事实留在事件链，模型运行在你的设备，证据只按最小范围披露。</span>
        </div>
      }
    />
  );
}
