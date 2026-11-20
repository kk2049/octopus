/**
 * Containment for a render error in one screen.
 *
 * Without a boundary, one throw while rendering unmounts React's whole tree:
 * the document goes blank and takes the navigation, the approvals drawer and
 * the issue reporter with it. Wrapped page content degrades to a small panel
 * instead, and the trusted shell around it stays usable.
 *
 * Recovery is always the reader's gesture. Retrying on a timer a render that
 * just threw is a busy loop; "重试" remounts the screen once, "刷新页面" asks
 * the server for the document again. React itself reports the caught error.
 */

import { Component, type ReactNode } from "react";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText } from "../i18n/ui-text.js";
import { UiButton } from "../ui-kit/primitives.js";
import styles from "./misc.module.css";

/** Long enough to identify a bug, short enough not to become a payload. */
const MESSAGE_MAX = 300;

interface State {
  message: string | null;
}

export class PageErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    const raw = error instanceof Error ? error.message : String(error);
    return { message: raw.slice(0, MESSAGE_MAX) };
  }

  private retry = (): void => this.setState({ message: null });

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return <PageErrorPanel message={this.state.message} onRetry={this.retry} />;
  }
}

function PageErrorPanel({ message, onRetry }: { message: string; onRetry(): void }) {
  useDashboardLanguage();
  return (
    <div className={styles.pageError} role="alert" data-testid="page-error">
      <strong>{uiText("这个页面出错了")}</strong>
      <p>{uiText("导航和其他页面仍可使用。可以重试，或刷新整个页面。")}</p>
      {message ? <code>{message}</code> : null}
      <div className={styles.pageErrorActions}>
        <UiButton onClick={onRetry}>{uiText("重试")}</UiButton>
        <UiButton tone="primary" onClick={() => window.location.reload()}>{uiText("刷新页面")}</UiButton>
      </div>
    </div>
  );
}
