/**
 * 模块演示 — a composition root with nothing in it but composition.
 *
 * ── What this program is, and is not ────────────────────────────────────────
 *
 * It runs in a frame with an opaque origin: no cookie jar, no parent DOM, no
 * fetch/XHR/WebSocket/EventSource, no forms, no popups, no top navigation, and
 * no idea who is logged in. Its only supported channel is the MessagePort the
 * trusted shell transfers in — and over that channel it can only PROPOSE. Owner,
 * app, scope, instance, approval and capability are the Host's, and are never
 * sent in either direction.
 *
 * ── What is left here, and what deliberately is not ─────────────────────────
 *
 * One element and a title bar. `StandardApp` does the assembly every App's root
 * was doing by hand — build the registry, link the plan, mount the providers,
 * render `WorkspaceShell` with slot chrome, paint the status line — and this App
 * supplies the only genuinely App-specific input: which contract its own channel
 * satisfies, and with which adapter.
 *
 * NOT here, and each absence is checkable:
 *
 *  · **No `adapters` and no `bindings`.** A declared App binds no user
 *    resources; `plan.ts`'s header has the refusal that makes that structural.
 *    `providers` is the other table — an App's own projection and actions, which
 *    arrive over the channel it already has and which no deployment installs.
 *  · **No action strings.** The two this App declares live in the composition in
 *    `plan.ts`, where a reviewer reads them. `data.form/v1` proposes
 *    `config.action` and the deck modules propose `config.command_action`; this
 *    file names neither.
 *  · **No resource logic.** Row selection, deck editing, command sequencing,
 *    projection reading and every refusal state belong to the module packages.
 *  · **No identity hook.** There is no `useIdentity`/`useOwner`/`useCapability`
 *    to reach for — the View is never told, so such a hook could only invent.
 */

import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { SHOWCASE_COMPOSITION } from "./plan.js";
import { SHOWCASE_MODULES } from "./modules.js";

/**
 * The whole of this App's wiring.
 *
 * A module-level constant rather than an inline literal: `StandardApp` keys its
 * port memo on the CONTRACT IDS so an inline table does not rebuild ports on
 * every render, but a constant makes that a property of the code rather than of
 * a memo key somebody could change.
 */
const PROVIDERS = Object.freeze({ [APP_DATA_CONTRACT]: appDataAdapter });

export function App() {
  return (
    <StandardApp
      composition={SHOWCASE_COMPOSITION}
      modules={SHOWCASE_MODULES}
      providers={PROVIDERS}
      className="showcase"
      backLabel="返回笔记"
      // The bottom strip carries two panels — the compose form and the generated
      // Typst — so it is a row rather than the shell's single-card default. The
      // merge is per slot, so naming `bottom` does not drop the rail's splitter.
      chrome={{ bottom: { className: "showcase-foot" } }}
      header={
        <div className="showcase-head">
          <b>模块演示</b>
          <span className="showcase-sub">笔记 + 幻灯：六个可复用模块，零 App 组件</span>
        </div>
      }
    />
  );
}
