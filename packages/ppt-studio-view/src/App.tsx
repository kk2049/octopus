import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { PPT_STUDIO_COMPOSITION } from "./plan.js";
import { PPT_STUDIO_MODULES } from "./modules.js";

const PROVIDERS = Object.freeze({ [APP_DATA_CONTRACT]: appDataAdapter });

export function App() {
  return (
    <StandardApp
      composition={PPT_STUDIO_COMPOSITION}
      modules={PPT_STUDIO_MODULES}
      providers={PROVIDERS}
      className="ppt-studio"
      backLabel="返回幻灯片"
      chrome={{ bottom: { className: "ppt-studio-brief" } }}
      header={
        <div className="ppt-studio-head">
          <b>PPT Studio</b>
          <span>按需技能 · 结构化画布 · Typst 派生导出</span>
        </div>
      }
    />
  );
}
