import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { REPORT_SPACE_COMPOSITION } from "./plan.js";
import { REPORT_SPACE_MODULES } from "./modules.js";
const PROVIDERS = Object.freeze({ [APP_DATA_CONTRACT]: appDataAdapter });
export function App() {
  return <StandardApp
    composition={REPORT_SPACE_COMPOSITION} modules={REPORT_SPACE_MODULES} providers={PROVIDERS}
    presentation="dock-documents" className="report-space" backLabel="返回汇报"
    dock={{ surfaceClassName: { navigation: "report-fixed-rail", bottom: "report-fixed-actions", primary: "report-document" } }}
    header={<div className="report-head"><div><span>SHARED REPORTING</span><b>汇报空间</b></div><p>成员关系是 ACL；汇报、讨论与结论是同一条可审计事实链。</p></div>}
  />;
}
