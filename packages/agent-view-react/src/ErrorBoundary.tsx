/**
 * Containment for a rendering bug in App code.
 *
 * The rule it exists to keep is the third boundary rule read from this side:
 * **failure is a state, not an exception.** A throw inside an App component
 * unmounts React's whole tree by default, which in this frame means a blank
 * document that still holds an open MessagePort — the Host sees a View that
 * handshook and then went silent, which is indistinguishable from a hostile one
 * playing dead. With a boundary the frame degrades to a legible line, the
 * transport stays open, and the Host's own recovery (rebuild the generation)
 * remains the thing that fixes it.
 *
 * What it must NOT do, and does not: reload the document, navigate, or retry on
 * a timer. Retrying a render that just threw is how a frame becomes a busy loop,
 * and the person watching already has a working "重建视图" button in trusted
 * chrome. `reset()` is exposed for an App that has a legitimate way back (a
 * different tab, a cleared filter) and is never called automatically.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

export interface AgentViewErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the subtree. Receives a bounded message. */
  fallback?: (error: { message: string; reset(): void }) => ReactNode;
  /** Observability hook for the App; must not throw. */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface State {
  message: string | null;
}

/** Long enough to identify a bug, short enough not to become a payload. */
const MESSAGE_MAX = 300;

export class AgentViewErrorBoundary extends Component<AgentViewErrorBoundaryProps, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    const raw = error instanceof Error ? error.message : String(error);
    return { message: raw.slice(0, MESSAGE_MAX) || "未知错误" };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      this.props.onError?.(error, info);
    } catch {
      // An observer that throws must not take the fallback down with it.
    }
  }

  private reset = (): void => this.setState({ message: null });

  render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback({ message, reset: this.reset });
    return (
      <div className="av-banner" role="alert">
        <span aria-hidden="true">⚠</span>
        <div>
          <strong>这个视图渲染失败了</strong>
          <span> · {message}</span>
          <div className="av-banner-note">
            可信外层不受影响；用它上方的「重建视图」按钮可以重新加载这个 App。
          </div>
        </div>
      </div>
    );
  }
}
