import { uiText } from "../i18n/ui-text.js";
/**
 * The 🐞 button: file what you are looking at, from wherever you are looking.
 *
 * ── Why it moved into the shell ─────────────────────────────────────────────
 *
 * It used to live in the Session Plus trust bar, which meant the one page with
 * a dedicated bug-reporting affordance was the page least likely to be the one
 * with the bug. Every other surface — tickets, permissions, apps, HQ — had no
 * entry at all, so a report about them started with "go to /tickets, open the
 * composer, describe the other page from memory". The dock is mounted once by
 * `Shell`, so it is present on every page the shell renders, and it always
 * knows which page that is.
 *
 * ── What it collects, and why each piece is there ───────────────────────────
 *
 *  · **model and effort.** They were fixed constants before, so a report that
 *    needed a different backend could not ask for one without re-filing by
 *    hand. Same roster the ticket composer reads.
 *  · **an element ADDRESS.** The previous pick reported a bounded subtree —
 *    tags, classes, text — which describes what an element looks like and not
 *    where it is. `element-path` leads with a selector chain that resolves back
 *    to the element, so an agent can grep for it. On an ordinary page the
 *    picker is local; inside Session Plus it is the View's own, over the debug
 *    channel, because the trusted page cannot read that DOM.
 *  · **pictures.** Paste one, or take one with the browser's screen capture.
 *    Either way it becomes a chip with an ✕ and one line in the body naming
 *    the absolute path the agent should read.
 *
 * Everything the ticket will contain is visible in the panel before it is
 * sent — the rule the Session Plus form was written under, kept.
 *
 * ── Who owns "open" (ticket #207) ───────────────────────────────────────────
 *
 * The dock used to own that flag and expose exactly one way in: a 🐞 pinned to
 * the bottom-right corner. On a phone that corner is scarce — it is where pages
 * park their own primary action — so the floating trigger became a wide-viewport
 * affordance and the narrow-viewport entry moved into the shell's menu card.
 * Two triggers on two surfaces cannot each keep their own boolean, so `open` is
 * a prop now and `Shell` holds the state. The panel is still rendered here, by
 * the dock, in one place.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorText } from "../lib/api.js";
import { useBrowserDraft } from "../lib/browser-drafts-react.js";
import { bootstrap } from "../lib/bootstrap.js";
import { AttachmentStrip, useAttachments } from "../ui/Attachments.js";
import {
  captureScreenshot,
  createElementPicker,
  currentFramePicker,
  screenCaptureSupported,
  type ElementPicker,
} from "../lib/element-picker.js";
import type { PickedElementLike } from "../lib/element-path.js";
import { composeFeedbackBody, readFlightHook } from "../lib/flight.js";
import { UiButton, UiSelect, UiTextArea } from "../ui-kit/primitives.js";
import { Status } from "../ui/misc.js";
import { useMessages } from "../i18n/react.js";
import { TicketExecutionFields, useTicketExecution } from "../ui/TicketExecutionFields.js";
import { ticketModelLabel, ticketModelSource, type TicketModelChoice } from "../pages/tickets/model.js";
import styles from "./DebugDock.module.css";

interface Roster {
  execution_choices?: Record<string, import("../contract.js").TicketExecutionOptions>;
  models?: string[];
  model_catalog?: TicketModelChoice[];
  efforts?: string[];
  model_default?: string;
  effort_default?: string;
  requester_choices?: string[];
  tickets?: Array<{
    id: number;
    body: string;
    requester: string;
    created_at: string;
  }>;
}

const DRAG_SLOP = 5;
const VIEWPORT_MARGIN = 8;

interface DockOffset {
  x: number;
  y: number;
}

interface DockDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: DockOffset;
  startRect: DOMRect;
  moved: boolean;
}

function serverChoice(options: readonly string[] | undefined, preferred: string | undefined): string {
  return preferred && options?.includes(preferred) ? preferred : options?.[0] ?? "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A create response can be lost after the server has committed the ticket.
 * Reconcile that uncertain result against the read-only roster instead of
 * retrying the mutation and filing the same report twice.
 */
function reconciledTicketId(input: {
  roster: Roster;
  body: string;
  requester: string;
  knownIds: ReadonlySet<number> | null;
  startedAt: number;
}): number | null {
  const matches = (input.roster.tickets ?? []).filter((ticket) => {
    if (!Number.isSafeInteger(ticket.id) || ticket.body !== input.body) return false;
    if (input.requester && ticket.requester !== input.requester) return false;
    if (input.knownIds) return !input.knownIds.has(ticket.id);
    const createdAt = Date.parse(ticket.created_at);
    return Number.isFinite(createdAt) && createdAt >= input.startedAt - 120_000;
  });
  matches.sort((a, b) => b.id - a.id);
  return matches[0]?.id ?? null;
}

export function DebugDock({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useMessages();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const owner = roster?.requester_choices?.[0] ?? bootstrap.viewer.username ?? "";
  const execution = useTicketExecution(roster?.execution_choices?.[owner], ticketModelSource(roster?.model_catalog, model), owner);
  const descriptionDraft = useBrowserDraft(
    `debug-dock:${window.location.pathname}${window.location.search}`,
  );
  const [picked, setPicked] = useState<PickedElementLike | null>(null);
  const [picking, setPicking] = useState(false);
  const attachmentDraft = useAttachments(open ? `debug:${owner}` : "closed");
  const executionKey = JSON.stringify([open, owner, model, effort, execution.payload]);
  const latestExecution = useRef(executionKey);
  latestExecution.current = executionKey;
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  const [created, setCreated] = useState<number | null>(null);
  const [approvalQueued, setApprovalQueued] = useState("");
  const [dockOffset, setDockOffset] = useState<DockOffset>({ x: 0, y: 0 });
  const [draggingDock, setDraggingDock] = useState(false);
  const picker = useRef<ElementPicker | null>(null);
  const pickGeneration = useRef(0);
  const dockToggle = useRef<HTMLButtonElement | null>(null);
  const dockDrag = useRef<DockDrag | null>(null);
  const suppressDockClick = useRef(false);

  // A resized desktop viewport must not strand a previously moved trigger off
  // screen. The phone layout hides this trigger, so a zero-sized box is left
  // alone until it becomes visible again.
  useEffect(() => {
    const keepDockInViewport = (): void => {
      const rect = dockToggle.current?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return;
      const dx = rect.left < VIEWPORT_MARGIN
        ? VIEWPORT_MARGIN - rect.left
        : rect.right > window.innerWidth - VIEWPORT_MARGIN
          ? window.innerWidth - VIEWPORT_MARGIN - rect.right
          : 0;
      const dy = rect.top < VIEWPORT_MARGIN
        ? VIEWPORT_MARGIN - rect.top
        : rect.bottom > window.innerHeight - VIEWPORT_MARGIN
          ? window.innerHeight - VIEWPORT_MARGIN - rect.bottom
          : 0;
      if (dx || dy) setDockOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
    };
    window.addEventListener("resize", keepDockInViewport);
    return () => window.removeEventListener("resize", keepDockInViewport);
  }, []);

  // The roster is a server-local ticket listing, not a capability-bearing
  // read, and it is fetched once the panel is actually opened rather than on
  // every page load: a dock nobody pressed should cost one button.
  useEffect(() => {
    if (!open || roster) return;
    let live = true;
    void api<Roster>("/api/tickets").then(
      (value) => {
        if (!live) return;
        setRoster(value);
        // The server names its defaults; the first offered choice covers a
        // roster that omits them.
        setModel((current) => current || serverChoice(value.models, value.model_default));
        setEffort((current) => current || serverChoice(value.efforts, value.effort_default));
      },
      (err) => {
        if (live) setFailure(errorText(err) || t("debug.modelListFailed"));
      },
    );
    return () => {
      live = false;
    };
  }, [open, roster, t]);

  useEffect(() => () => {
    pickGeneration.current += 1;
    picker.current?.stop();
  }, []);

  const startPick = useCallback(async (): Promise<void> => {
    setFailure("");
    const inFrame = currentFramePicker();
    const generation = ++pickGeneration.current;
    setPicking(true);
    if (inFrame) {
      // The page that owns the frame answers; it is the only thing that can.
      try {
        const result = await inFrame();
        if (generation !== pickGeneration.current) return;
        if (result) setPicked(result);
        else setFailure(t("debug.pickViewUnavailable"));
      } catch (err) {
        if (generation === pickGeneration.current) {
          setFailure(errorText(err) || t("debug.pickViewFailed"));
        }
      } finally {
        if (generation === pickGeneration.current) setPicking(false);
      }
      return;
    }
    picker.current?.stop();
    picker.current = createElementPicker(document, (result) => {
      if (generation !== pickGeneration.current) return;
      setPicked(result);
      setPicking(false);
    });
    picker.current.start();
  }, [t]);

  const clearPick = useCallback((): void => {
    pickGeneration.current += 1;
    picker.current?.stop();
    picker.current = null;
    setPicking(false);
    setPicked(null);
    setFailure("");
  }, []);

  const capture = useCallback(async (): Promise<void> => {
    setFailure("");
    setApprovalQueued("");
    // Capture itself belongs to this attachment generation, so closing the
    // dock before the browser picker returns cannot populate the next draft.
    await attachmentDraft.addFiles(captureScreenshot().then((file) => [file], (error: unknown) => {
      const name = (error as { name?: string } | null)?.name;
      if (name === "NotAllowedError" || name === "AbortError") return [];
      throw error;
    })).catch(() => {}); // Shared attachment strip owns the visible failure.
  }, [attachmentDraft]);

  const submit = useCallback(async (): Promise<void> => {
    if (!roster || !execution.ready) return;
    setFailure("");
    setApprovalQueued("");
    setBusy(t("debug.creating"));
    try {
      await attachmentDraft.ready();
      if (latestExecution.current !== executionKey) throw new Error(uiText("执行选择已变化，请重新发送。"));
    } catch (err) {
      setFailure(errorText(err));
      setBusy("");
      return;
    }
    const completeAttachments = attachmentDraft.markSubmission();
    const submission = descriptionDraft.beginSubmission();
    const startedAt = Date.now();
    const knownIds = roster?.tickets
      ? new Set(roster.tickets.flatMap((ticket) => Number.isSafeInteger(ticket.id) ? [ticket.id] : []))
      : null;
    const requester = roster?.requester_choices?.[0] ?? bootstrap.viewer.username ?? "";
    let submittedBody = "";
    const acceptCreated = (id: number): void => {
      setCreated(id);
      descriptionDraft.completeSubmission(submission);
      setPicked(null);
      completeAttachments();
    };
    try {
      const flight = readFlightHook();
      submittedBody = composeFeedbackBody({
        description: submission?.text ?? descriptionDraft.text,
        route: `${window.location.pathname}${window.location.search}`,
        picked,
        timeline: flight?.timeline() ?? [],
        violations: flight?.violations() ?? [],
        trailer: attachmentDraft.compose(""),
      });
      const out = await api<{
        ticket?: { id: number };
        approval_required?: boolean;
        message?: string;
      }>("/api/tickets", {
        method: "POST",
        json: {
          body: submittedBody,
          kind: "simple",
          model,
          effort,
          ...execution.payload,
          ...(roster?.requester_choices?.length ? { requester: roster.requester_choices[0] } : {}),
        },
      });
      if (out.approval_required) {
        // The request now lives in the approval queue. Treat that receipt like
        // a created ticket so a refresh cannot resurrect the already-consumed
        // report and invite a duplicate submission.
        descriptionDraft.completeSubmission(submission);
        completeAttachments();
        setApprovalQueued(out.message ?? t("composer.approvalQueued"));
        return;
      }
      if (!out.ticket) throw new Error(t("composer.serverMissingTicket"));
      acceptCreated(out.ticket.id);
    } catch (err) {
      // An HTTP refusal is authoritative. A transport/shape failure is not:
      // the server may already have committed and started the ticket before
      // the response disappeared, so confirm via one replay-safe roster read.
      if (!(err instanceof ApiError) && submittedBody) {
        setBusy(t("debug.checking"));
        try {
          const refreshed = await api<Roster>("/api/tickets");
          const id = reconciledTicketId({
            roster: refreshed,
            body: submittedBody,
            requester,
            knownIds,
            startedAt,
          });
          if (id !== null) {
            acceptCreated(id);
            return;
          }
        } catch {
          // Keep the original create failure: it is the operation the person
          // needs to understand, while this read was only best-effort proof.
        }
      }
      if (err instanceof ApiError && [401, 403, 404, 422].includes(err.status)) {
        descriptionDraft.restoreSubmission(submission);
      }
      setFailure(errorText(err) || t("debug.createFailed"));
    } finally {
      setBusy("");
    }
  }, [attachmentDraft, descriptionDraft, effort, model, picked, roster, t, execution, executionKey]);

  const onDockPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dockDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: dockOffset,
      startRect: event.currentTarget.getBoundingClientRect(),
      moved: false,
    };
  };

  const onDockPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dockDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) <= DRAG_SLOP) return;
      drag.moved = true;
      setDraggingDock(true);
      // Capture only after crossing the drag threshold. Immediate capture can
      // retarget an ordinary click and make the report button appear broken.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; the in-button drag still works.
      }
    }
    const boundedX = clamp(
      dx,
      VIEWPORT_MARGIN - drag.startRect.left,
      window.innerWidth - VIEWPORT_MARGIN - drag.startRect.right,
    );
    const boundedY = clamp(
      dy,
      VIEWPORT_MARGIN - drag.startRect.top,
      window.innerHeight - VIEWPORT_MARGIN - drag.startRect.bottom,
    );
    setDockOffset({
      x: drag.startOffset.x + boundedX,
      y: drag.startOffset.y + boundedY,
    });
  };

  const finishDockDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dockDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressDockClick.current = true;
    dockDrag.current = null;
    setDraggingDock(false);
  };

  const cancelDockDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (dockDrag.current?.pointerId !== event.pointerId) return;
    dockDrag.current = null;
    setDraggingDock(false);
  };

  const onDockClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (suppressDockClick.current) {
      suppressDockClick.current = false;
      event.preventDefault();
      return;
    }
    onOpenChange(!open);
  };

  return (
    <div className={styles.dock} data-debug-dock>
      {open ? (
        <section className={styles.panel} aria-label={t("debug.panelLabel")}>
          <header className={styles.head}>
            <strong>{t("debug.title")}</strong>
            <span className={styles.grow} />
            <UiButton aria-label={t("shell.close")} onClick={() => onOpenChange(false)}>✕</UiButton>
          </header>
          <p className={styles.lead}>{t("debug.lead")}</p>
          <UiTextArea
            id="debugDockBody"
            placeholder={t("debug.placeholder")}
            value={descriptionDraft.text}
            onChange={(event) => descriptionDraft.set(event.target.value)}
            onPaste={attachmentDraft.onPaste}
          />
          <AttachmentStrip draft={attachmentDraft} />
          <div className={styles.fields}>
            <label className="srOnly" htmlFor="debugDockModel">{t("composer.model")}</label>
            <UiSelect
              id="debugDockModel"
              wrapLabels
              value={model}
              onValueChange={setModel}
              options={(roster?.models ?? []).map((value) => ({
                value,
                label: t("composer.modelOption", { model: ticketModelLabel(value, roster?.model_catalog) }),
              }))}
            />
            <label className="srOnly" htmlFor="debugDockEffort">{uiText("推理强度")}</label>
            <UiSelect
              id="debugDockEffort"
              wrapLabels
              value={effort}
              onValueChange={setEffort}
              options={(roster?.efforts ?? []).map((value) => ({ value, label: `${uiText("推理强度")}: ${value}` }))}
            />
          </div>
          <div className={styles.fields}><TicketExecutionFields selection={execution} idPrefix="debug-execution" wrapLabels /></div>
          <div className={styles.row}>
            <UiButton id="debugDockPick" onClick={() => void startPick()}>
              {picking ? t("debug.picking") : picked ? t("debug.repick") : t("debug.pick")}
            </UiButton>
            {picked ? (
              <UiButton id="debugDockClearPick" onClick={clearPick}>{t("debug.clearPick")}</UiButton>
            ) : null}
            {screenCaptureSupported() ? (
              <UiButton id="debugDockShot" onClick={() => void capture()}>{t("debug.capture")}</UiButton>
            ) : null}
            <UiButton
              id="debugDockSubmit"
              className="primary"
              disabled={!descriptionDraft.text.trim() || Boolean(busy) || !roster || !execution.ready}
              onClick={() => void submit()}
            >
              {t("debug.create")}
            </UiButton>
          </div>
          {picked ? (
            <div className={styles.picked}>
              {typeof picked.selector === "string" ? (
                <code className={styles.selector}>{picked.selector}</code>
              ) : null}
              <pre className="small">{JSON.stringify(picked.subtree ?? picked, null, 1).slice(0, 1_200)}</pre>
            </div>
          ) : null}
          {busy ? <Status kind="ok">{busy}</Status> : null}
          {failure ? <Status kind="err">{failure}</Status> : null}
          {approvalQueued ? <Status kind="ok">{approvalQueued}</Status> : null}
          {created ? (
            <a href="/tickets" target="_blank" rel="noopener noreferrer">
              {t("debug.created", { id: created })}
            </a>
          ) : null}
        </section>
      ) : null}
      {/*
        Hidden below 720px (see the stylesheet): on a phone the shell's menu
        card carries this entry instead, so the corner stays the page's.
      */}
      <button
        ref={dockToggle}
        type="button"
        id="debugDockToggle"
        className={styles.toggle}
        data-dragging={draggingDock || undefined}
        aria-expanded={open}
        aria-label={open ? t("shell.collapseFeedback") : t("shell.reportIssue")}
        title={t("shell.dragReportHint")}
        style={{ transform: `translate(${dockOffset.x}px, ${dockOffset.y}px)` }}
        onPointerDown={onDockPointerDown}
        onPointerMove={onDockPointerMove}
        onPointerUp={finishDockDrag}
        onPointerCancel={cancelDockDrag}
        onClick={onDockClick}
      >
        🐞
      </button>
    </div>
  );
}

/** Whether this viewer has the dev pipeline the dock files tickets into. */
export function debugDockAvailable(): boolean {
  return bootstrap.features.includes("dev-pipeline") && bootstrap.viewer.dev;
}
