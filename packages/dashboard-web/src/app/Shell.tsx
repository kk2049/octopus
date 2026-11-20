import { UiButton } from "../ui-kit/primitives.js";
/**
 * The trusted chrome: one nav, one identity chip, one approval affordance, one
 * quota strip, one dead-man deploy banner.
 *
 * ── What is trusted about it ────────────────────────────────────────────────
 *
 * Nothing here decides anything. The tabs are the list the SERVER said it would
 * serve this viewer (`bootstrap.nav`, filtered by the same `routeIsAvailable` +
 * audience rules the router uses), so navigation cannot advertise a page that
 * would 404 — and if it somehow did, the page would still get the server's
 * refusal rather than a rendered screen. The approval pill exists only when the
 * server said this request arrived on a real browser login, because a bearer
 * credential is deliberately not evidence that a person is present to approve
 * execution.
 *
 * ── Logging out is a state change ───────────────────────────────────────────
 *
 * It ends a session and destroys the Contexts derived from it, so it is a POST
 * through the shared API client (which attaches the CSRF header) and never a
 * link — `<img src="/logout">` on any page on the internet would otherwise have
 * logged people out.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router";
import { bootstrap } from "../lib/bootstrap.js";
import {
  onServerBuildChanged,
  request,
  sessionExpired,
  subscribeSessionExpired,
} from "../lib/api.js";
import { loginUrl } from "../lib/recovery.js";
import { ApprovalDrawer, rememberPending, useApprovalQueue } from "./Approvals.js";
import { QuotaChips } from "./Quota.js";
import { SystemStatus } from "./SystemStatus.js";
import { DeployBanner } from "./DeployBanner.js";
import { DeployProgressBanner } from "./DeployProgressBanner.js";
import { uiText } from "../i18n/ui-text.js";
import { DebugDock, debugDockAvailable } from "./DebugDock.js";
import { ColorSchemeToggle } from "./ColorSchemeToggle.js";
import { LanguagePicker } from "./LanguagePicker.js";
import styles from "./Shell.module.css";
import { THEMES, chooseTheme, currentTheme, subscribeTheme } from "../styles/themes.js";
import { navigationLabel, themeLabel } from "../i18n/messages.js";
import { useMessages } from "../i18n/react.js";
import brandLockup from "../assets/octopus-lockup-horizontal.svg";

const PageActionsContext = createContext<HTMLElement | null>(null);

/**
 * One or two page-owned trusted actions may join the permanent shell row.
 * The shell owns geometry; the page still owns callbacks and authorization.
 */
export function ShellPageActions({ children }: { children: ReactNode }) {
  const host = useContext(PageActionsContext);
  return host ? createPortal(children, host) : null;
}

/**
 * The one-click aesthetic switch. The local transition is immediate and the
 * explicit choice is then stored for the current account through one guarded
 * mutation. There is no retry or polling; localStorage remains the fallback.
 *
 * The picker subscribes to the theme store (ticket #45): a sibling tab
 * choosing a different theme dispatches a `storage` event, which the store
 * turns into a local `applyTheme` → publish. Reading through
 * `useSyncExternalStore` means this `<select>` follows automatically, so
 * `<html data-theme>`, the iframe, and the picker never disagree — the
 * previous `useState(currentTheme)` version left the picker stuck on the
 * value it observed at mount.
 */
// Exported for `ThemePicker.test.tsx` — mounting the whole Shell just to
// reach the `<select>` would need the bootstrap payload, API stubs and the
// approval / deploy chrome; the picker itself is a pure store subscriber
// and testable in isolation.
export function ThemePicker() {
  const { language, t } = useMessages();
  const theme = useSyncExternalStore<string>(subscribeTheme, currentTheme, currentTheme);
  return (
    <select
      aria-label={t("theme.label")}
      className={styles.themePick}
      value={theme}
      onChange={(event) => { void chooseTheme(event.target.value); }}
    >
      {THEMES.map((choice) => (
        <option key={choice.id} value={choice.id}>
          🎨 {themeLabel(language, choice.id, choice.label)}
        </option>
      ))}
    </select>
  );
}

function IdentityChip() {
  const { t } = useMessages();
  const viewer = bootstrap.viewer;
  const label = viewer.username
    ? `${viewer.admin ? "🔑 " : "🧑 "}${viewer.username}`
    : `🔑 ${t("shell.adminKey")}`;
  return <span className={styles.chip}>{label}</span>;
}

/** Compact desktop popover; on phones CSS keeps the same expandable region inside the navigation card. */
export function StatusAndPreferences({ devEnabled }: { devEnabled: boolean }) {
  return (
    <details className={styles.statusMenu} data-testid="status-and-preferences">
      <summary className={styles.statusSummary}>{uiText("状态与偏好")}</summary>
      <div className={styles.statusPanel}>
        <div className={styles.preferenceRow}>
          <LanguagePicker className={styles.themePick} />
          <ThemePicker />
          <ColorSchemeToggle />
        </div>
        {devEnabled ? <QuotaChips /> : null}
        {devEnabled ? <SystemStatus /> : null}
      </div>
    </details>
  );
}

function LogoutButton() {
  const { t } = useMessages();
  const [busy, setBusy] = useState(false);
  return (
    <UiButton
      className={styles.tab}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          // A failure here still sends the browser to /login: the server may be
          // mid-restart, and leaving somebody staring at a panel they believe
          // they left is worse than an extra login.
          await request("/logout", { method: "POST" });
        } catch {
          /* best effort */
        } finally {
          location.href = "/login";
        }
      }}
    >
      {t("shell.logout")}
    </UiButton>
  );
}

/**
 * A new build is published while a tab is open.
 *
 * The bundle is one immutable, content-addressed file, so this tab keeps
 * working on the bytes it already has — nothing breaks and nothing must be
 * forced. What it must not do is silently stay behind, so it says so once.
 */
function UpdateBanner() {
  const { t } = useMessages();
  const [stale, setStale] = useState(false);
  useEffect(() => onServerBuildChanged(() => setStale(true)), []);
  if (!stale) return null;
  return (
    <div className={styles.update} role="status">
      {t("shell.updateAvailable")}
      <UiButton className="primary" onClick={() => location.reload()}>
        {t("shell.refresh")}
      </UiButton>
    </div>
  );
}

function replaceDocument(url: string): void {
  location.replace(url);
}

/** Session expiry suspends requests; only the user can leave this document. */
export function SessionExpiredOverlay({ navigate = replaceDocument }: { navigate?: (url: string) => void } = {}) {
  const { t } = useMessages();
  const expired = useSyncExternalStore(
    subscribeSessionExpired,
    sessionExpired,
    sessionExpired,
  );
  const target = loginUrl();
  if (!expired) return null;
  return (
    <div className={styles.update} role="status">
        <strong id="session-expired-title">{t("shell.loginExpired")}</strong>
        <span>{uiText("请先保留正在编辑的内容，再重新登录。页面不会自动跳转。")}</span>
        <UiButton tone="primary" onClick={() => navigate(target)}>
          {t("shell.goToLogin")}
        </UiButton>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { language, t } = useMessages();
  const approvals = useApprovalQueue(bootstrap.approvals);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [pageActionsHost, setPageActionsHost] = useState<HTMLDivElement | null>(null);
  const seenPending = useRef(new Set<string>());
  const actionable = [...approvals.notices, ...approvals.items];
  const devEnabled = bootstrap.features.includes("dev-pipeline") && bootstrap.viewer.dev;
  const debugAvailable = debugDockAvailable();
  const pathname = window.location.pathname;
  const currentNav = [...bootstrap.nav]
    .sort((left, right) => right.path.length - left.path.length)
    .find((item) => item.path === "/" ? pathname === "/" : pathname === item.path || pathname.startsWith(`${item.path}/`));

  useEffect(() => {
    if (!navigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [navigationOpen]);

  // `#approvals` is the deep link the transcript's operation chips point at, so
  // "在顶部批准 →" works from inside a conversation without leaving it.
  useEffect(() => {
    const check = () => {
      if (window.location.hash === "#approvals") setDrawerOpen(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  // A genuinely new frozen call or account-recovery notice opens the compact
  // panel once. Polling the same server id does not nag again.
  useEffect(() => {
    const current = [...approvals.notices, ...approvals.items];
    const fresh = rememberPending(seenPending.current, current);
    if (seenPending.current.size > 200) {
      seenPending.current = new Set(current.map((item) => item.id));
    }
    if (fresh) setDrawerOpen(true);
  }, [approvals.items, approvals.notices]);

  return (
    <PageActionsContext.Provider value={pageActionsHost}>
      <nav className={styles.nav} aria-label={t("shell.mainNavigation")}>
        <img className={styles.brand} src={brandLockup} alt="octopus" />
        <span className={styles.mobileCurrent}>
          {currentNav ? navigationLabel(language, currentNav.id, currentNav.label) : t("shell.workspace")}
        </span>
        <div
          ref={setPageActionsHost}
          className={styles.pageActions}
          data-shell-page-actions
        />
        <UiButton
          className={styles.mobileMenuButton}
          aria-label={navigationOpen ? t("shell.closeNavigation") : t("shell.openNavigation")}
          aria-controls="mobile-navigation"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen((open) => !open)}
        >
          {navigationOpen ? t("shell.close") : t("shell.menu")}
        </UiButton>
        <div
          id="mobile-navigation"
          className={`${styles.navigationBody} ${navigationOpen ? styles.navigationOpen : ""}`}
        >
          {bootstrap.nav.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              // Every page owns server-composed pageProps and is authorized per
              // document request. An SPA transition would render the target with
              // the previous page's props and skip that page request entirely.
              // Full navigation also lets Session Plus pagehide retire its
              // backend instance before another document takes over.
              reloadDocument
              // `end` matters for "/": without it every route would light up the
              // overview tab, because every path starts with a slash.
              end={item.path === "/"}
              // `tab` is a stable name alongside the scoped one: the browser suite
              // asserts that trusted navigation survived a view rebuild, and it
              // needs a selector that a CSS-module hash does not change.
              className={({ isActive }) =>
                isActive ? `tab active ${styles.tab} ${styles.active}` : `tab ${styles.tab}`
              }
            >
              {navigationLabel(language, item.id, item.label)}
            </NavLink>
          ))}
          <span className="grow" />
          <StatusAndPreferences devEnabled={devEnabled} />
          {/*
            Ticket #207: on a phone the dock's floating 🐞 sat on top of
            whatever the page put in the bottom-right corner. The entry moved
            in here — the menu card is the shell's existing home for chrome
            that does not fit a narrow bar — and the floating trigger is a
            wide-viewport affordance from now on (`DebugDock.module.css`).
            The panel itself stays where it was: one dock, two ways in.
          */}
          {debugAvailable ? (
            <UiButton
              id="debugDockMenuEntry"
              className={styles.debugEntry}
              aria-expanded={debugOpen}
              onClick={() => {
                setNavigationOpen(false);
                setDebugOpen((open) => !open);
              }}
            >
              🐞 {t("shell.reportIssue")}
            </UiButton>
          ) : null}
          {bootstrap.approvals ? (
            <UiButton
              // A stable id, because the browser suite opens this from outside the
              // app and there is nothing else on the page that means "approve".
              id="approvalPill"
              data-testid="approval-activity-toggle"
              className={`${styles.pill} ${actionable.length ? styles.hot : ""}`}
              aria-expanded={drawerOpen}
              onClick={() => {
                setNavigationOpen(false);
                setDrawerOpen((open) => !open);
              }}
            >
              🔔 {t("shell.approvals")} <span id="approvalCount" data-testid="approval-count">{actionable.length}</span>
            </UiButton>
          ) : null}
          <IdentityChip />
          <LogoutButton />
        </div>
      </nav>
      <SessionExpiredOverlay />
      <UpdateBanner />
      {devEnabled ? <DeployBanner /> : <DeployProgressBanner />}
      {bootstrap.approvals ? (
        <ApprovalDrawer open={drawerOpen} onOpenChange={setDrawerOpen} queue={approvals} />
      ) : null}
      <div className={styles.page}>{children}</div>
      {/*
        Ticket #201: the bug-report entry is the shell's, not one page's. It
        used to live in the Session Plus trust bar, which put the only
        reporting affordance on the one page least likely to be the one with
        the problem. Mounted here it is present wherever the shell is, and it
        reads the current address itself instead of being told.
      */}
      {debugAvailable ? <DebugDock open={debugOpen} onOpenChange={setDebugOpen} /> : null}
    </PageActionsContext.Provider>
  );
}
