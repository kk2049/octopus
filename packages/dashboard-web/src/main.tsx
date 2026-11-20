/**
 * Browser entry point.
 *
 * `StrictMode` is on. It only changes development behaviour, and the behaviour
 * it changes — mounting effects twice — is exactly the class of bug this app
 * must not have: a duplicated `EventSource`, a second poll, an effect that
 * performs a mutation. Keeping it on means those show up while the change is
 * being written rather than in production, and `useEventSource` is written and
 * tested to survive it.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@claude-bot/chat-ui-commons/transcript-ui.css";
import { App } from "./app/App.js";
import { bootstrap } from "./lib/bootstrap.js";
import "./styles/index.css";
import { initMobileControlFont, initTheme } from "./styles/themes.js";
import { initColorScheme } from "./styles/color-scheme.js";
import { initLanguage } from "./i18n/language.js";
import { DashboardUiProvider } from "./ui-kit/UiProvider.js";

// Before the first render, so component copy, Ant locale and the document's
// language metadata all agree from the first React frame.
initLanguage();
// The initial paint is already in the reader's chosen theme rather than
// flashing classic for one frame.
initTheme(bootstrap.themePreference);
initColorScheme();
initMobileControlFont();

const container = document.getElementById("root");
if (!container) throw new Error("dashboard root element is missing");

createRoot(container).render(
  <StrictMode>
    <DashboardUiProvider>
      <App />
    </DashboardUiProvider>
  </StrictMode>,
);
