/**
 * Modal dialog and side drawer, on Ant Design primitives.
 *
 * The hand-built panel had three different modal-ish things — a `<dialog>` on
 * the workbench, a `hidden`-toggled `<aside>` for approvals, and a `confirm()`
 * for everything else — and only the first had focus management. The approval
 * drawer in particular was reachable by keyboard but never received focus, so a
 * keyboard user opened it and stayed on the pill behind it.
 *
 * Ant supplies focus restore on close, `Escape`, scroll locking, responsive
 * sizing and consistent themed chrome. This adapter also closes the Drawer's
 * end-of-cycle Tab gap so focus cannot briefly escape to the document body.
 * Keeping it here means pages do not depend on Ant's portal API directly.
 */

import type { KeyboardEvent, ReactNode } from "react";
import Drawer from "antd/es/drawer";
import Modal from "antd/es/modal";
import { UiButton } from "../ui-kit/primitives.js";
import { useMessages } from "../i18n/react.js";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Sentence under the title; also the dialog's accessible description. */
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** `drawer` docks to the top-right (the approval surface); `modal` centres. */
  variant?: "modal" | "drawer";
  /** Width in pixels for the modal variant. */
  width?: number;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keep a masked drawer's Tab cycle inside its semantic panel. */
function trapDrawerTab(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.closest("[hidden], [aria-hidden='true']"));
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  variant = "modal",
  width,
}: DialogProps) {
  const content = (
    <>
      {description ? <p className="muted">{description}</p> : null}
      {children}
    </>
  );
  if (variant === "drawer") {
    return (
      <Drawer
        open={open}
        onClose={() => onOpenChange(false)}
        title={title}
        size={width ?? 460}
        footer={footer}
        destroyOnHidden
        onKeyDown={trapDrawerTab}
      >
        {content}
      </Drawer>
    );
  }
  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title={title}
      width={width}
      footer={footer ?? null}
      destroyOnHidden
    >
      {content}
    </Modal>
  );
}

/**
 * A yes/no question that blocks a dangerous action.
 *
 * Replaces `window.confirm`, which cannot be styled, cannot carry markup, is
 * suppressible by the browser, and blocks the event loop — the last of which
 * made the deploy banner's poll stall behind an unanswered prompt.
 */
export interface ConfirmProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const { t } = useMessages();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      width={430}
      footer={
        <>
          <UiButton onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </UiButton>
          <UiButton
            tone={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            loading={busy}
          >
            {busy ? t("common.processing") : (confirmLabel ?? t("common.confirm"))}
          </UiButton>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
