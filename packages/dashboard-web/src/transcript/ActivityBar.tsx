/**
 * "What is it doing right now" — its own node, ticking once a second.
 *
 * It is a sibling of the message list rather than part of it, and that is
 * load-bearing: the per-second tick must not re-render the transcript, because
 * re-rendering the transcript is what collapses the folds the reader opened.
 *
 * Every value it shows is a function of NOW (see `lib/transcript.ts`), so a
 * session that stopped writing simply stops being described instead of counting
 * upward forever.
 */

import { Dots, Spinner, useNow } from "../ui/misc.js";
import { formatElapsed } from "../lib/format.js";
import {
  activityPhase,
  elapsedOf,
  isBusy,
  silenceOf,
  type Activity,
} from "../lib/transcript.js";
import { useMessages } from "../i18n/react.js";
import { message, type MessageValues } from "../i18n/messages.js";
import type { DashboardLanguageId } from "../i18n/language.js";
import styles from "./ActivityBar.module.css";

type Translator = (key: Parameters<typeof message>[1], values?: MessageValues) => string;

function localizedActivityLabel(activity: Activity | null, t: Translator): string {
  if (activity?.state === "thinking") return t("activity.thinking");
  if (activity?.state === "responding") return t("activity.responding");
  if (activity?.state === "tool") {
    return t("activity.tool", { tool: activity.tool || t("activity.toolFallback") });
  }
  return t("activity.running");
}

export function ActivityBar({ activity }: { activity: Activity | null }) {
  const { language, t } = useMessages();
  const now = useNow(isBusy(activity));
  const phase = activityPhase(activity, now);
  if (!phase) return null;
  if (phase === "stale") {
    return (
      <div className={`${styles.bar} ${styles.stale}`} role="status">
        {t("activity.stale", { duration: formatElapsed(silenceOf(activity, now), language) })}
      </div>
    );
  }
  const elapsed = elapsedOf(activity, now);
  return (
    <div className={styles.bar} role="status">
      <Spinner />
      <span className="muted">{t("activity.assistant")}</span>
      <span>
        {localizedActivityLabel(activity, t)}
        <Dots />
      </span>
      {elapsed >= 0
        ? <span className="muted">{t("activity.elapsed", { duration: formatElapsed(elapsed, language) })}</span>
        : null}
    </div>
  );
}

/**
 * Strip for state the SERVER vouches for — the dev pipeline holds its child
 * process, so it knows a turn is running even when the log says nothing yet.
 */
export function PlainActivityBar({ label, since }: { label: string; since?: string }) {
  const { language, t } = useMessages();
  const now = useNow(true);
  const elapsed = elapsedOf({ state: "running", since }, now);
  return (
    <div className={styles.bar} role="status">
      <Spinner />
      <span className="muted">{t("activity.assistant")}</span>
      <span>
        {label}
        <Dots />
      </span>
      {elapsed >= 0
        ? <span className="muted">{t("activity.elapsed", { duration: formatElapsed(elapsed, language) })}</span>
        : null}
    </div>
  );
}

/** One-line status for the live indicator; "" when there is nothing to say. */
export function activityStatusText(
  activity: Activity | null,
  nowMs: number,
  language: DashboardLanguageId = "zh-CN",
): string {
  const t: Translator = (key, values) => message(language, key, values);
  const phase = activityPhase(activity, nowMs);
  if (!phase) return "";
  if (phase === "stale") {
    return t("activity.stale", {
      duration: formatElapsed(silenceOf(activity, nowMs), language),
    });
  }
  const elapsed = elapsedOf(activity, nowMs);
  return `${localizedActivityLabel(activity, t)}…${
    elapsed >= 0 ? ` ${t("activity.elapsed", { duration: formatElapsed(elapsed, language) })}` : ""
  }`;
}
