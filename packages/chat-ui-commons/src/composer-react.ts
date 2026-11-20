import { useEffect, useState } from "react";
import { COMPACT_CHAT_MEDIA_QUERY, isCompactChatViewport } from "./composer.js";

/**
 * Live content-width state for chat surfaces. Rotation and split-screen changes
 * update the layout; callers never infer a phone from user-agent or pointer.
 */
export function useCompactChatViewport(): boolean {
  const [compact, setCompact] = useState(() => isCompactChatViewport());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(COMPACT_CHAT_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    if (typeof media.addListener === "function") {
      media.addListener(onChange);
      return () => media.removeListener(onChange);
    }
    return;
  }, []);

  return compact;
}
