import { AvButton, AvInput } from "@claude-bot/agent-view-react/ui";
/**
 * In-place text editing on the slide surface.
 *
 * ── The commit model, stated once ───────────────────────────────────────────
 *
 * A region shows the PROJECTION's value until it is clicked; the click opens an
 * input seeded from that value; Enter or blur commits; Escape abandons. One
 * commit is one gesture and maps to exactly one `set_text` (the module decides
 * that — this component only reports "the person replaced X with Y"), which is
 * why the canvas needs no save button: there is no N-command batch left to
 * save. The seed travels WITH the commit so the module can detect the
 * two-writers case — this channel has no expected-digest check, so an edit that
 * landed on top of somebody else's is detected and said, never prevented.
 *
 * ── Why display mode is a <AvButton> ──────────────────────────────────────────
 *
 * "Click to edit" needs a keyboard equivalent or it is mouse-only. A button
 * gives focus, Enter and a role for free, and the stylesheet strips its chrome
 * so it reads as slide text. The empty state renders the placeholder inside
 * the same button — an empty title with no click target would be a field that
 * can never be filled in again.
 *
 * `maxLength` is the wire bound (512): a value the transport would refuse is
 * better refused by the input than by a refusal banner after the fact.
 */

import { useEffect, useRef, useState } from "react";
import { DECK_LIMITS } from "@claude-bot/deck-model-contract";

export interface InlineTextProps {
  /** What the projection currently says. */
  value: string;
  /** What an empty region invites. */
  placeholder: string;
  /** Typography class of the region — the input inherits it, so type does not jump. */
  className: string;
  /** For the accessibility tree and the tests: 标题 / 要点 第 1 条 / … */
  label: string;
  /** Region name for `data-dkv-region`, e.g. `title` or `bullets:0`. */
  region: string;
  /** A read-only surface renders plain text and no affordance. */
  disabled?: boolean;
  onCommit(next: string, seed: string): void;
}

export function InlineText({ value, placeholder, className, label, region, disabled, onCommit }: InlineTextProps) {
  const [editing, setEditing] = useState<{ seed: string; draft: string } | null>(null);

  if (disabled) {
    return value ? (
      <span className={className} data-dkv-region={region}>
        {value}
      </span>
    ) : null;
  }

  if (!editing) {
    return (
      <AvButton
        className={`dkv-inline ${className}`}
        data-dkv-region={region}
        data-dkv-empty={value ? undefined : "1"}
        aria-label={`编辑${label}`}
        onClick={() => setEditing({ seed: value, draft: value })}
      >
        {value || placeholder}
      </AvButton>
    );
  }

  const commit = () => {
    setEditing(null);
    if (editing.draft !== editing.seed) onCommit(editing.draft, editing.seed);
  };

  return (
    <AvInput
      className={`dkv-inline-input ${className}`}
      data-dkv-region={region}
      aria-label={label}
      autoFocus
      maxLength={DECK_LIMITS.maxTextLength}
      value={editing.draft}
      onChange={(event) => setEditing({ seed: editing.seed, draft: event.target.value })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        else if (event.key === "Escape") setEditing(null);
      }}
    />
  );
}

export interface NewItemTextProps {
  /** e.g. 添加要点 / 添加左栏内容 — the affordance's text and the input's label. */
  label: string;
  field: string;
  /** A full list (16) offers no affordance rather than a refusal after typing. */
  full: boolean;
  onCommit(value: string): void;
}

/**
 * The trailing "add an item" row of a list on the canvas.
 *
 * Enter commits AND keeps the input open — writing bullets is a run, not a
 * click-per-line ceremony — while blur commits what is there and closes.
 * An empty draft commits nothing: an accidental click must not grow the list.
 */
export function NewItemText({ label, field, full, onCommit }: NewItemTextProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const keep = useRef(false);

  // `autoFocus` only fires on mount, and Enter keeps the SAME input mounted —
  // so refocus by hand when a commit cleared it.
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (keep.current) {
      keep.current = false;
      input.current?.focus();
    }
  });

  if (full) return null;

  if (draft === null) {
    return (
      <li className="dkv-sur-add">
        <AvButton data-dkv-item-add={field} onClick={() => setDraft("")}>
          ＋ {label}
        </AvButton>
      </li>
    );
  }

  const commit = (again: boolean) => {
    const value = draft;
    if (again) {
      keep.current = true;
      setDraft("");
    } else {
      setDraft(null);
    }
    if (value) onCommit(value);
  };

  return (
    <li className="dkv-sur-add">
      <AvInput
        ref={input}
        className="dkv-inline-input dkv-sur-itemtext"
        aria-label={label}
        autoFocus
        maxLength={DECK_LIMITS.maxTextLength}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(true);
          else if (event.key === "Escape") setDraft(null);
        }}
      />
    </li>
  );
}
