import { SharePage } from "../pages/SessionSharing.js";
/**
 * The router.
 *
 * ── How client routing coexists with server authorization ───────────────────
 *
 * The server decides, per request, whether a page exists for this viewer, and
 * it serves this document ONLY after that decision passed. So a typed URL, a
 * bookmark or a link from outside still gets the server's own login redirect /
 * 403 / 404 — there is no SPA fallback that would turn a refusal into a
 * rendered screen. Script/API requests retain a machine-readable 401.
 *
 * `bootstrap.pageProps` belongs to exactly this server-rendered route. Main
 * navigation therefore performs a document request (see Shell's
 * `reloadDocument`) so the target page gets its own authorization decision and
 * pageProps. The router only selects the screen for the document that arrived;
 * it is not an SPA data router.
 */

import { lazy, Suspense, type ComponentType } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { bootstrap } from "../lib/bootstrap.js";
import { createQueryClient } from "../lib/query.js";
import { Shell } from "./Shell.js";
import { PAGE_PATHS } from "./routes.js";
import { Loading } from "../ui/misc.js";
import { PageErrorBoundary } from "../ui/PageErrorBoundary.js";
const OverviewPage = lazy(() => import("../pages/OverviewPage.js").then((module) => ({ default: module.OverviewPage })));
const TicketsPage = lazy(() => import("../pages/TicketsPage.js").then((module) => ({ default: module.TicketsPage })));
const AdminPage = lazy(() => import("../pages/AdminPage.js").then((module) => ({ default: module.AdminPage })));
const LauncherPage = lazy(() => import("../pages/LauncherPage.js").then((module) => ({ default: module.LauncherPage })));
const PendingPage = lazy(() => import("../pages/PendingPage.js").then((module) => ({ default: module.PendingPage })));
const PermissionsPage = lazy(() => import("../pages/PermissionsPage.js").then((module) => ({ default: module.PermissionsPage })));
const SessionPlusPage = lazy(() => import("../pages/SessionPlusPage.js").then((module) => ({ default: module.SessionPlusPage })));
const AppsPage = lazy(() => import("../pages/AppsPage.js").then((module) => ({ default: module.AppsPage })));
const AppOpenPage = lazy(() => import("../pages/AppOpenPage.js").then((module) => ({ default: module.AppOpenPage })));
const ArchitecturePage = lazy(() => import("../pages/ArchitecturePage.js").then((module) => ({ default: module.ArchitecturePage })));
const KnowledgePage = lazy(() => import("../pages/KnowledgePage.js").then((module) => ({ default: module.KnowledgePage })));
const DocKeyPage = lazy(() => import("../pages/DocKeyPage.js").then((module) => ({ default: module.DocKeyPage })));
import { LoginPage } from "../pages/LoginPage.js";
import { RegisterPage } from "../pages/RegisterPage.js";
import type { LoginPageProps, RegisterPageProps } from "../contract.js";
import { useMessages } from "../i18n/react.js";

const SCREENS: Record<string, ComponentType> = {
  "page.overview": OverviewPage,
  "page.tickets": TicketsPage,
  "page.admin": AdminPage,
  "page.pending": PendingPage,
  "page.permissions": PermissionsPage,
  "page.sessionsPlus": SessionPlusPage,
  "page.apps": AppsPage,
  "page.appOpen": AppOpenPage,
  "page.launcher": LauncherPage,
  "page.architecture": ArchitecturePage,
  "page.knowledge": KnowledgePage,
};

function NotServedHere() {
  const { t } = useMessages();
  return (
    <div style={{ margin: "40px auto", maxWidth: 640, padding: "0 16px" }}>
      <h2>{t("app.notAvailable")}</h2>
      <p className="muted">{t("app.notAvailableDetail")}</p>
      <p>
        <a href="/">← {t("app.home")}</a>
      </p>
    </div>
  );
}

const queryClient = createQueryClient();

/**
 * Two boundaries: one around the routed screen, so a page that throws while
 * rendering leaves the shell (navigation, approvals, issue reporting) in place,
 * and an outer one so nothing at all can leave a blank document.
 */
export function App() {
  return <PageErrorBoundary><Screens /></PageErrorBoundary>;
}

function Screens() {
  if (bootstrap.page === "pre.sessionShare") return <SharePage />;
  // A Feishu document's claim link: public, no identity, its own root like login.
  if (bootstrap.page === "pre.docShareKey") return <Suspense fallback={<Loading />}><DocKeyPage /></Suspense>;
  // The login screen is its own root: it has no identity to show, no nav to
  // filter and no queries to run.
  if (bootstrap.page === "pre.login") {
    return <LoginPage {...(bootstrap.pageProps as LoginPageProps)} />;
  }
  if (bootstrap.page === "pre.register") {
    return <RegisterPage {...(bootstrap.pageProps as RegisterPageProps)} />;
  }
  const served = new Set(bootstrap.pages);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell>
          <PageErrorBoundary>
            <Suspense fallback={<Loading />}>
              <Routes>
                {Object.entries(PAGE_PATHS).map(([id, path]) => {
                  const Screen = served.has(id) ? SCREENS[id] : NotServedHere;
                  return <Route key={id} path={path} element={<Screen />} />;
                })}
                <Route path="*" element={<NotServedHere />} />
              </Routes>
            </Suspense>
          </PageErrorBoundary>
        </Shell>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
