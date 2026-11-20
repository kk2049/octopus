import type { ReactNode } from "react";

/**
 * The navigation rail's activity bar: one icon per view, VS Code style.
 *
 * A vertical strip on the desktop, a tab row on the phone layer. Every view
 * stays mounted and only its visibility changes, so switching to search and
 * back keeps the file tree's expansion and each list's scroll position.
 */
export type NavigatorView = "sessions" | "files" | "search";

// Distinct from the phone shell's layer tabs (导航 / 会话 / 文件), which sit
// right above this bar and mean the chat and document layers.
const VIEWS: ReadonlyArray<{ id: NavigatorView; label: string }> = [
  { id: "sessions", label: "会话列表" },
  { id: "files", label: "文件树" },
  { id: "search", label: "全文搜索" },
];

export function Navigator({ view, onView, narrow, domIdScope, views }: {
  view: NavigatorView;
  onView(view: NavigatorView): void;
  narrow?: boolean;
  domIdScope?: string;
  views: Readonly<Record<NavigatorView, ReactNode>>;
}) {
  const id = (name: string) => `${domIdScope ? `${domIdScope}-` : ""}nav-${name}`;
  return (
    <div className={`navigator${narrow ? " narrow" : ""}`} data-av-navigator data-view={view}>
      <div
        className="activity-bar"
        role="tablist"
        aria-label="导航视图"
        aria-orientation={narrow ? "horizontal" : "vertical"}
        onKeyDown={(event) => {
          const step = event.key === (narrow ? "ArrowRight" : "ArrowDown") ? 1
            : event.key === (narrow ? "ArrowLeft" : "ArrowUp") ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next = VIEWS[(VIEWS.findIndex((entry) => entry.id === view) + step + VIEWS.length) % VIEWS.length]!;
          onView(next.id);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-av-nav-view="${next.id}"]`)?.focus();
        }}
      >
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={id(`tab-${entry.id}`)}
            className="activity-tab"
            data-av-nav-view={entry.id}
            aria-selected={view === entry.id}
            aria-controls={id(`panel-${entry.id}`)}
            aria-label={entry.label}
            title={entry.label}
            tabIndex={view === entry.id ? 0 : -1}
            onClick={() => onView(entry.id)}
          >
            <ViewGlyph view={entry.id} />
            {narrow ? <span className="activity-label">{entry.label}</span> : null}
          </button>
        ))}
      </div>
      {VIEWS.map((entry) => (
        <div
          key={entry.id}
          role="tabpanel"
          id={id(`panel-${entry.id}`)}
          aria-labelledby={id(`tab-${entry.id}`)}
          className="navigator-view"
          hidden={view !== entry.id}
        >
          {views[entry.id]}
        </div>
      ))}
    </div>
  );
}

function ViewGlyph({ view }: { view: NavigatorView }) {
  const common = { className: "activity-glyph", viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": true, focusable: false } as const;
  if (view === "sessions") {
    return (
      <svg {...common}>
        <path d="M4 5.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H10l-4 3v-3H4A1.5 1.5 0 0 1 2.5 14V7A1.5 1.5 0 0 1 4 5.5z"
          fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M21.5 9.5v6.5A1.5 1.5 0 0 1 20 17.5h-1v2.5l-3-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "files") {
    return (
      <svg {...common}>
        <path d="M8 3.5h7l4 4V18a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 18V5A1.5 1.5 0 0 1 8 3.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M15 3.5V7.5h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M4.5 7v12.5A1.5 1.5 0 0 0 6 21h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15 15l5.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
