/** The shared React context for one caller-owned App runtime. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentViewClient, AgentViewSnapshot, ProposalReply } from "./client.js";
import { AgentViewContext } from "./context.js";
import { AgentViewUiProvider } from "./AgentViewUiProvider.js";

/** The Host already bounds its refusal text; bounding it again is one line. */
const REFUSAL_TEXT_MAX = 500;

export interface AgentViewProviderProps {
  children: ReactNode;
  /** The shell or preview owns construction, connections and teardown. */
  client: AgentViewClient;
  /** The ordinary Dashboard already owns the document UI provider and theme. */
  uiProvider?: boolean;
  reflectAppearance?: boolean;
  /**
   * Wording for a refusal. The default names the action and quotes the Host's
   * own sentence, because "who said no" is the part a person needs.
   */
  refusalText?: (action: string, reply: ProposalReply) => string;
}

function defaultRefusalText(action: string, reply: ProposalReply): string {
  return `可信外层拒绝了 ${action || "动作"}：${reply.message}`;
}

export function AgentViewProvider({ children, client, refusalText, uiProvider = true, reflectAppearance = true }: AgentViewProviderProps) {
  return (
    <ActiveAgentViewProvider client={client} refusalText={refusalText} uiProvider={uiProvider} reflectAppearance={reflectAppearance}>
      {children}
    </ActiveAgentViewProvider>
  );
}

/**
 * The DOM side of ticket #45: mirror the current appearance onto <html>.
 *
 * Kept in the provider (not in `client.ts`) because the transport is
 * framework-neutral and side-effect-free on the DOM — writing an attribute is
 * the App runtime's job. Kept OUT of a public `useAppearance` hook (ticket
 * #45 correction) because everything the modules need today comes from
 * `data-av-theme` + the `--av-*` tokens; a hook only makes sense once a
 * component genuinely needs to branch on the theme in JS, and inventing one
 * now would encourage exactly that kind of branching.
 *
 * Three rules:
 * - The write runs in `useLayoutEffect`, which fires BEFORE the browser
 *   paints the committed frame. `useEffect` would let the paint go through
 *   with the previous attribute value first — a one-frame classic flash on
 *   the initial boot, and a one-frame previous-theme flash on every switch.
 *   That is exactly the property "first paint is already themed" the ticket
 *   pins.
 * - `classic` maps to the ABSENCE of the attribute. The unstyled attribute
 *   name would still bind the `[data-av-theme="classic"]` selector nobody
 *   has written; leaving the attribute off keeps the :root token values
 *   authoritative for classic (this mirrors the outer shell's own convention
 *   in `dashboard-web/styles/themes.ts`).
 * - The write is guarded by `typeof document`: the provider is also mounted
 *   from tests that don't stub `document` and from SSR paths that have no
 *   DOM at all. On such runs the effect is a no-op and the snapshot is still
 *   observable through the subscribed store.
 */
function useAppearanceReflection(client: AgentViewClient, enabled: boolean): void {
  const snapshot = useSyncExternalStore<AgentViewSnapshot>(
    useCallback((listener) => client.subscribe(listener), [client]),
    () => client.snapshot(),
    () => client.snapshot(),
  );
  useLayoutEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const theme = snapshot.appearance.theme;
    const html = document.documentElement;
    if (theme === "classic") {
      delete html.dataset.avTheme;
    } else {
      html.dataset.avTheme = theme;
    }
    html.style.setProperty("--mobile-control-font-size", `${snapshot.appearance.controlFontSize ?? 16}px`);
  }, [enabled, snapshot.appearance.theme, snapshot.appearance.controlFontSize]);
}

function ActiveAgentViewProvider({
  children,
  client,
  refusalText,
  uiProvider,
  reflectAppearance,
}: Required<Pick<AgentViewProviderProps, "children" | "client" | "uiProvider" | "reflectAppearance">> & Pick<AgentViewProviderProps, "refusalText">) {
  useAppearanceReflection(client, reflectAppearance);
  const [notice, setNotice] = useState("");
  const format = refusalText ?? defaultRefusalText;
  const formatRef = useRef(format);
  formatRef.current = format;

  const propose = useCallback(
    async (action: string, params?: Record<string, string>): Promise<ProposalReply> => {
      setNotice("");
      const reply = await client.propose(action, params);
      if (!reply.ok) setNotice(formatRef.current(action, reply).slice(0, REFUSAL_TEXT_MAX));
      return reply;
    },
    [client],
  );

  const clearNotice = useCallback(() => setNotice(""), []);
  const value = useMemo(
    () => ({ client, propose, notice, clearNotice }),
    [client, propose, notice, clearNotice],
  );

  return (
    <AgentViewContext.Provider value={value}>
      {uiProvider ? <AgentViewUiProvider>{children}</AgentViewUiProvider> : children}
    </AgentViewContext.Provider>
  );
}
