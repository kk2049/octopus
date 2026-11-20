import { useState } from "react";
import { UiButton } from "../../ui-kit/primitives.js";
import { Confirm } from "../../ui/Dialog.js";
import { useMessages } from "../../i18n/react.js";

/**
 * The ↻ in the trusted shell row: a real document reload.
 *
 * ── Why it stopped being a refetch (ticket #180) ────────────────────────────
 *
 * It used to call `refetch()` on the roster, the deploy state and the ticket
 * detail. That is not wrong, it is *invisible*: those three queries already
 * poll every 5–10 seconds, so by the time a person decides to press refresh the
 * data they are looking at is at most a few seconds old and the press changes
 * nothing on screen. A control that never visibly does anything is reported as
 * broken, and on a phone — where the tab may have been suspended for hours and
 * the panel may have been redeployed since the document was composed — the one
 * thing the reader actually wants from "refresh" is the thing a refetch cannot
 * do: get a NEW document, and with it the current bundle.
 *
 * `location.reload()` is exactly that. It re-requests the top-level document
 * from the server rather than the HTTP cache; the bundle is content-addressed
 * and immutable, so an unchanged build is still reused from cache and a new one
 * arrives under its new URL. There is nothing to "hard" beyond this — a
 * cache-busting query parameter would only pollute a shareable address.
 *
 * ── The one thing a reload can destroy ──────────────────────────────────────
 *
 * The unsent message draft. Ticket #180's other half exists precisely because
 * losing a draft to a stray keystroke is unacceptable, so losing one to a stray
 * 44px tap in the top bar is not acceptable either. The confirmation therefore
 * appears only when there is text to lose; with an empty box the press reloads
 * immediately, which is what "直接刷新" means.
 *
 * `reload` is injected so the behaviour is testable without replacing
 * `window.location`, the same seam `SessionExpiredOverlay` uses for `navigate`.
 */
export function HardRefreshAction({
  className,
  draftAtRisk,
  reload = () => window.location.reload(),
}: {
  className?: string;
  /** There is unsent text in the composer that a reload would drop. */
  draftAtRisk: boolean;
  reload?: () => void;
}) {
  const { t } = useMessages();
  const [confirming, setConfirming] = useState(false);
  const [reloading, setReloading] = useState(false);

  const go = (): void => {
    // A second tap must not queue a second navigation, and the label change is
    // the acknowledgement that the first one was received.
    if (reloading) return;
    setConfirming(false);
    setReloading(true);
    reload();
  };

  return (
    <>
      <UiButton
        className={className}
        aria-label={t("refresh.label")}
        title={t("refresh.title")}
        disabled={reloading}
        onClick={() => (draftAtRisk ? setConfirming(true) : go())}
      >
        {reloading ? "…" : "↻"}
      </UiButton>
      <Confirm
        open={confirming}
        title={t("refresh.label")}
        confirmLabel={t("refresh.confirm")}
        destructive
        body={t("refresh.body")}
        onConfirm={go}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
