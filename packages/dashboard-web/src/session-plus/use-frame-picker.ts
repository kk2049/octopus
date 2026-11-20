import { useCallback, useEffect, useRef, type RefObject } from "react";
import { registerFramePicker } from "../lib/element-picker.js";
import type { PickedElementLike } from "../lib/element-path.js";
import type { createSessionPlusHost } from "./frame-host.js";

type FrameHost = Pick<ReturnType<typeof createSessionPlusHost>, "debug">;

/** The report dock always asks the View to select inside its own document. */
export function useFramePicker(host: RefObject<FrameHost | null>) {
  const pending = useRef<((value: PickedElementLike | null) => void) | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const unregister = registerFramePicker(() => {
      pending.current?.(null);
      const mine = ++generation.current;
      // Install the resolver before arming: a fast click can beat the ACK.
      const result = new Promise<PickedElementLike | null>((resolve) => { pending.current = resolve; });
      void Promise.resolve(host.current?.debug("pick.start")).then((answer) => {
        if (generation.current === mine && !answer?.ok) {
          pending.current?.(null);
          pending.current = null;
        }
      }, () => {
        if (generation.current === mine) {
          pending.current?.(null);
          pending.current = null;
        }
      });
      return result;
    });
    return () => {
      unregister();
      generation.current++;
      pending.current?.(null);
      pending.current = null;
      void host.current?.debug("pick.stop").catch(() => {});
    };
  }, [host]);
  return useCallback((op: string, result: unknown) => {
    if (op !== "pick") return;
    const settle = pending.current;
    pending.current = null;
    settle?.(result && typeof result === "object" ? result as PickedElementLike : null);
  }, []);
}
