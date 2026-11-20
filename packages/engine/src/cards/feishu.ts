/**
 * Card-grade projection to a feishu card — the second face of the same page.
 *
 * One page definition, two renderers: the web client draws it from view JSON,
 * this module compiles it to feishu card JSON. Rich widgets degrade to a
 * deep link; buttons appear only for actions the viewer passes — the same
 * authz filter the web face and the agent's listActions use.
 *
 * Conventions pinned by golden tests mirror .claude/rules/dev-conventions.md:
 * header.title is a plain_text OBJECT; prose is {tag:"div", text:{tag:
 * "lark_md"}} (never tag:"markdown"); forms contain only inputs + submit.
 * The probe never sends real cards (e2e sim only) — this is shape discipline,
 * not feishu API truth, and says so honestly.
 */

import type { AppManifest, PageDef, PageNode } from "../manifest.js";
import { WIDGETS } from "./catalog.js";

export interface FeishuRenderOpts {
  /** Card title; falls back to page title / app title. */
  title?: string;
  /** Deep link to the web page, used by rich-widget degradation lines. */
  link?: string;
  /** Same predicate filter the web face uses (viewer × action). */
  allowed: (action: string) => boolean;
}

type Json = Record<string, unknown>;

const md = (content: string): Json => ({ tag: "div", text: { tag: "lark_md", content } });

function resolveBind(bind: string | undefined, view: unknown): unknown {
  if (!bind) return undefined;
  let cur: unknown = { view };
  for (const part of bind.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const toneMark = (tone: unknown): string => (tone === "err" ? "🔴 " : tone === "warn" ? "🟡 " : tone === "ok" ? "🟢 " : "");

function renderNode(node: PageNode, view: unknown, app: AppManifest, opts: FeishuRenderOpts): Json[] {
  const data = resolveBind(node.bind, view);
  const titled = (els: Json[]): Json[] => {
    const t = node.props?.title;
    return t ? [md(`**${String(t)}**`), ...els] : els;
  };
  switch (node.widget) {
    case "heading": {
      const d = (data ?? node.props ?? {}) as Record<string, unknown>;
      const sub = d.subtitle ? `\n${String(d.subtitle)}` : "";
      return [md(`**${String(d.title ?? "")}**${sub}`)];
    }
    case "section":
      return titled((node.children ?? []).flatMap((c) => renderNode(c, view, app, opts)));
    case "markdown":
      return titled([md(String(data ?? ""))]);
    case "kv": {
      const entries = Array.isArray(data)
        ? (data as Array<{ k: unknown; v: unknown }>).map((e) => [e.k, e.v] as const)
        : Object.entries((data ?? {}) as Record<string, unknown>);
      return titled([md(entries.map(([k, v]) => `**${String(k)}**：${String(v)}`).join("\n"))]);
    }
    case "list": {
      const items = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
      if (!items.length) return titled([md("（空）")]);
      return titled([
        md(
          items
            .map((it) => {
              const badge = it.badge ? ` \`${String(it.badge)}\`` : "";
              const sub = it.subtitle ? ` — ${String(it.subtitle)}` : "";
              return `${toneMark(it.tone)}**${String(it.title ?? it.id ?? "")}**${badge}${sub}`;
            })
            .join("\n"),
        ),
      ]);
    }
    case "table": {
      const t = (data ?? {}) as { columns?: unknown[]; rows?: unknown[][] };
      const cols = (t.columns ?? []).map(String);
      const rows = (t.rows ?? []).map((r) => r.map(String));
      return [md([cols.join(" | "), ...rows.map((r) => r.join(" | "))].join("\n"))];
    }
    case "banner": {
      if (!data) return [];
      const b = data as { tone?: string; text?: string };
      return [md(`${toneMark(b.tone)}${String(b.text ?? "")}`)];
    }
    case "actions": {
      const items = ((node.props?.items ?? []) as Array<Record<string, unknown>>).filter((it) =>
        opts.allowed(String(it.action)),
      );
      if (!items.length) return [];
      return [
        {
          tag: "action",
          actions: items.map((it) => ({
            tag: "button",
            text: { tag: "plain_text", content: String(it.label ?? app.actions[String(it.action)]?.title ?? it.action) },
            type: "primary",
            value: { app: app.app, action: String(it.action), params: (it.params as Json) ?? {} },
          })),
        },
      ];
    }
    case "form": {
      const action = String(node.props?.action ?? "");
      if (!opts.allowed(action)) return [];
      const spec = app.actions[action];
      const inputs = Object.entries(spec?.params ?? {}).map(([name, p]) => {
        const opts =
          p.enum ??
          (p.enumBind
            ? ((resolveBind(p.enumBind, view) as unknown[] | undefined) ?? []).map((o) =>
                o && typeof o === "object" ? String((o as { id?: unknown }).id) : String(o),
              )
            : null);
        const hint = opts?.length ? `（可选：${opts.slice(0, 6).join("、")}）` : "";
        return {
          tag: "input",
          name,
          required: p.required === true,
          placeholder: { tag: "plain_text", content: (p.description ?? name) + hint },
        };
      });
      return [
        {
          tag: "form",
          name: action,
          elements: [
            ...inputs,
            {
              tag: "button",
              text: { tag: "plain_text", content: spec?.title ?? action },
              action_type: "form_submit",
              name: "submit",
              value: { app: app.app, action },
            },
          ],
        },
      ];
    }
    default: {
      // Rich widget: degrade to the web deep link — chat+cards is the narrow
      // surface's contract, and it stays functionally complete via actions.
      const def = WIDGETS[node.widget];
      const link = opts.link ? `[打开网页](${opts.link})` : "请在网页端查看";
      return [md(`🔎 「${def?.name ?? node.widget}」为富组件，仅网页可用：${link}`)];
    }
  }
}

export function renderFeishuCard(
  app: AppManifest,
  page: PageDef,
  view: unknown,
  opts: FeishuRenderOpts,
): Json {
  const elements: Json[] = [];
  for (const slot of page.layout.flat()) {
    const node = page.slots[slot];
    if (!node) continue;
    elements.push(...renderNode(node, view, app, opts));
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: opts.title ?? page.title ?? app.title },
      template: "blue",
    },
    elements,
  };
}
