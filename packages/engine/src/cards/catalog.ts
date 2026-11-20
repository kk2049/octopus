/**
 * The curated widget catalog — T1 material, and deliberately a SHORT list.
 *
 * Admission rule (A2UI's "pre-approved catalog" discipline): a widget enters
 * `cardGrade: true` only with a proven mapping on EVERY surface (web + feishu
 * card). Rich widgets are web-only; on narrow surfaces the page degrades to
 * card-grade widgets + the bound agent's chat, which stays functionally
 * complete because discovery of actions is automatic (law #1).
 *
 * Growing this list is supposed to feel heavy. That is the point.
 */

export interface WidgetDef {
  name: string;
  cardGrade: boolean;
  /** Events a page may wire with `on:`. */
  events?: string[];
  /** Container widgets hold `children:` (a list of nodes) instead of a bind. */
  container?: boolean;
  description: string;
}

export const WIDGETS: Record<string, WidgetDef> = {
  heading: {
    name: "heading",
    cardGrade: true,
    description: "Title + optional subtitle. bind → {title, subtitle?} or use props.",
  },
  section: {
    name: "section",
    cardGrade: true,
    container: true,
    description:
      "Container: props.title + children (a LIST of nodes) stacked in one card. The title+list idiom without inventing a layout row.",
  },
  markdown: {
    name: "markdown",
    cardGrade: true,
    description: "md-lite prose. bind → string.",
  },
  kv: {
    name: "kv",
    cardGrade: true,
    description: "Fact sheet. bind → Record<string, string|number> or [{k, v}].",
  },
  list: {
    name: "list",
    cardGrade: true,
    events: ["select"],
    description:
      "Items with {id, title, subtitle?, badge?, tone?: ok|warn|err}. bind → array. on.select fires with the item id.",
  },
  table: {
    name: "table",
    cardGrade: true,
    description: "bind → {columns: string[], rows: (string|number)[][]}.",
  },
  banner: {
    name: "banner",
    cardGrade: true,
    description: "One status line. bind → {tone: ok|warn|err, text} | null.",
  },
  form: {
    name: "form",
    cardGrade: true,
    description:
      "Input form generated from ONE action's param specs (props.action). Submit dispatches that action — the same door as the API and the agent tool.",
  },
  actions: {
    name: "actions",
    cardGrade: true,
    description:
      "Button row. props.items = [{action, label?, params?}]. Buttons render only when the viewer passes the action's predicate — and exactly that set is what the bound agent can call.",
  },
  timeline: {
    name: "timeline",
    cardGrade: false,
    events: ["select"],
    description: "Tri-tense timeline (past/today/future). bind → {past, today, future}: [{id, at?, text, tone?}].",
  },
  "agent-chat": {
    name: "agent-chat",
    cardGrade: false,
    description: "Chat pane bound to a page agent (manifest agents.<name>). The universal degradation surface.",
  },
  docedit: {
    name: "docedit",
    cardGrade: false,
    description:
      "Click-to-edit formatted document (bind → markdown string, props.action → the save action receiving {text}). For human+agent co-written docs: both faces write through the same action, the log keeps every revision.",
  },
};
