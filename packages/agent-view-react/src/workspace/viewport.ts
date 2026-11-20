/**
 * "Is this a narrow screen" as a subscription, and its honest failure mode.
 *
 * `matchMedia` is the browser's own answer, so it is preferred to reading a
 * width — it fires on orientation changes and on zoom, which a resize listener
 * over `innerWidth` gets wrong. Where it does not exist (jsdom, and any host
 * that has not implemented it) this returns `false` rather than guessing from
 * `innerWidth`: a workspace that thinks it is narrow when it is not hides the
 * navigation rail, and "wide" is the state where nothing is hidden.
 *
 * The layout consequences are the reducer's — this only reports the fact.
 */

import { useEffect, useState } from "react";

export function useNarrowViewport(maxWidthPx = 720): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(`(max-width: ${maxWidthPx}px)`)
      : null;
    if (!media) return;
    setNarrow(media.matches);
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [maxWidthPx]);
  return narrow;
}
