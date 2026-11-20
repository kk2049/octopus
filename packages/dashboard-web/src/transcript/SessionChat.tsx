/**
 * The trusted panel's binding of its local chat shell.
 *
 * The implementation deliberately mirrors the Agentic App's window bar,
 * load-earlier gating, folds and scroll preservation without importing code
 * from that untrusted bundle. This binding injects the panel's `Markdown`
 * (untrusted prose never becomes HTML here either) and spinner.
 */

import { useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ChatTranscript,
  DASHBOARD_CHAT_CLASSES,
  type ChatTranscriptClasses,
} from "./ChatTranscript.js";
import type { TranscriptWindow } from "../lib/transcript.js";
import { findFilePaths } from "@claude-bot/chat-ui-commons/file-mentions";
import { fileReference } from "../lib/file-reference.js";
import { Markdown, MarkdownFileLinks } from "../ui/Markdown.js";
import { Spinner } from "../ui/misc.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { transcriptCopy } from "../i18n/transcript.js";
import { uiText } from "../i18n/ui-text.js";

const CLASSES: ChatTranscriptClasses = {
  ...DASHBOARD_CHAT_CLASSES,
};

function renderAssistant(text: string) {
  return <Markdown>{text}</Markdown>;
}

function renderSpinner() {
  return <Spinner />;
}

async function copyResponse(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export interface SessionChatProps {
  resource: string | null;
  data: TranscriptWindow | null;
  busy?: boolean;
  /** The page's live-follow chip, rendered inside the scrollable stream. */
  chip?: ReactNode;
  /** Local send bubbles share the transcript scroll owner. */
  tail?: ReactNode;
  className?: string;
  domIdScope?: string;
  idleText?: string;
  loadingText?: string;
  emptyText?: string;
  onLoadOlder(): void;
}

const EMPTY_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({});

export function SessionChat({ className, busy = false, resource, ...rest }: SessionChatProps) {
  const openFile = useContext(MarkdownFileLinks);
  const onOpenFile = useCallback((path: string) => {
    const file = fileReference(path);
    if (file) openFile?.(file);
  }, [openFile]);
  const language = useDashboardLanguage();
  const copy = transcriptCopy(language);
  const classes = useMemo(
    () => (className ? { ...CLASSES, transcript: `${CLASSES.transcript} ${className}` } : CLASSES),
    [className],
  );
  // Sticky fold choices, keyed by each group's or card's STABLE message anchor:
  // a live update or prepended page cannot re-fold what the reader opened, and
  // derived defaults apply only to disclosures the reader has not touched.
  // Same discipline and the same override map as the Agent View side.
  const [overridesByResource, setOverridesByResource] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const overrides = resource ? overridesByResource[resource] ?? EMPTY_OVERRIDES : EMPTY_OVERRIDES;
  const onToggleGroup = useCallback(
    (key: string, open: boolean) => {
      if (!resource) return;
      setOverridesByResource((previous) => ({
        ...previous,
        [resource]: { ...(previous[resource] ?? {}), [key]: open },
      }));
    },
    [resource],
  );
  return (
    <>
    {rest.data?.runtime?.recovery?.state === "waiting_capacity" ? <p role="status" data-testid="codex-capacity-wait">
      {uiText("Codex 容量不足，等待自动续接（已尝试 {v0}/6 次，最多 30 分钟）。", { v0: rest.data.runtime.recovery.attempts ?? 0 })}
      {rest.data.runtime.recovery.retry_at ? uiText("下次续接：{v0}。可以停止当前任务取消重试。", { v0: rest.data.runtime.recovery.retry_at }) : null}
    </p> : null}
    <ChatTranscript
      {...rest}
      busy={busy}
      classes={classes}
      copy={copy}
      expandOverrides={overrides}
      onToggleGroup={onToggleGroup}
      renderAssistant={renderAssistant}
      renderSpinner={renderSpinner}
      onCopyResponse={copyResponse}
      {...(openFile ? { onOpenFile, extractFilePaths: findFilePaths } : {})}
      resource={resource}
    />
    </>
  );
}
