/**
 * The preview entry.
 *
 * It is the production entry with two substitutions and nothing else: the
 * transport is a fixture client instead of a MessagePort. A composition still
 * reaches `StandardApp`; a bespoke View calls its production render function.
 * Everything after the provider boundary is therefore the same code that ships.
 *
 * The banner is not decoration. A preview looks exactly like the real thing,
 * which is its whole value and also its one hazard: nothing here is authorised,
 * nothing is persisted, and every answer came out of a fixture.
 */

import { createRoot } from "react-dom/client";
import plan from "app-preview-plan";
import { AgentViewErrorBoundary, AgentViewProvider } from "@claude-bot/agent-view-react";
import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { createFixtureAgentViewClient } from "../fixture-client.js";
import { previewTitle } from "../plan.js";

const fixture = createFixtureAgentViewClient({
  projection: plan.projection ?? null,
  operations: plan.operations,
  actions: plan.actions,
});

// One place a person can reach the fixture from the console while looking at a
// draft: replace the projection, see the workspace react. It is a dev server
// global on a loopback port serving fixture data — there is nothing here that a
// released bundle could ever acquire, because this module is not in one.
Object.assign(globalThis as Record<string, unknown>, { __appPreview: fixture });

const title = previewTitle(plan);
document.title = `${title} · 预览`;

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <AgentViewProvider client={fixture.client}>
      <AgentViewErrorBoundary>
        {plan.kind === "custom" ? (
          <>
            <div className="preview-head">
              <b>{title}</b>
              <span>自定义 View 预览 · 数据来自 fixture · 没有 Host、没有授权、不写任何东西</span>
            </div>
            <div className="preview-custom-root">{plan.render()}</div>
          </>
        ) : (
          <StandardApp
            composition={plan.composition}
            {...(plan.bindings ? { bindings: plan.bindings } : {})}
            modules={plan.modules}
            {...(plan.adapters ? { adapters: plan.adapters } : {})}
            {...(plan.providers ? { providers: plan.providers } : {})}
            {...(plan.narrowPx === undefined ? {} : { narrowPx: plan.narrowPx })}
            {...(plan.presentation ? { presentation: plan.presentation } : {})}
            {...(plan.dock ? { dock: plan.dock } : {})}
            {...(plan.className ? { className: plan.className } : {})}
            header={
              <div className="preview-head">
                <b>{title}</b>
                <span>预览 · 数据来自 fixture · 没有 Host、没有授权、不写任何东西</span>
              </div>
            }
          />
        )}
      </AgentViewErrorBoundary>
    </AgentViewProvider>,
  );
}
