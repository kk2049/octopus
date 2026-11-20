/**
 * One slide, rendered as a 16:9 surface — the SAME component at every scale.
 *
 * ── Why one component and not a thumbnail renderer beside a canvas one ──────
 *
 * The rail shows a deck as a film strip and the canvas shows one slide large,
 * and the only honest relationship between the two is that they are the same
 * rendering at different sizes. Two renderers would be two opinions about what
 * a `two-column` slide looks like, and the first divergence would make the
 * thumbnail a lie about the canvas. So this component draws the layout ONCE,
 * all type is sized in container-relative units (`cqw`), and whoever mounts it
 * decides how wide it is. `slide-surface.test.tsx` holds the claim to it.
 *
 * ── Where the colours come from ─────────────────────────────────────────────
 *
 * `DECK_THEME_COLOURS` — the contract's own statement of what `light` and
 * `dark` mean, the same six values the Typst preamble prints. They arrive as
 * inline custom properties (`--dkv-page`, `--dkv-ink`, `--dkv-faint`), so the
 * stylesheet still contains no colour literal and the surface previews the
 * DOCUMENT's theme rather than the app's colour scheme: a light deck stays a
 * light deck inside a dark dashboard, exactly as the exported page would.
 *
 * ── The three injection points, and why they exist ──────────────────────────
 *
 * A thumbnail is inert; a canvas edits in place. The layout must not fork over
 * that difference, so the interactive parts are injected: `text` renders one
 * text region (the canvas passes an inline editor, the default is a plain
 * span), `itemChrome` appends per-item controls inside a list row, and
 * `listFoot` appends a final row to a list (the canvas's "add an item"). The
 * defaults render nothing extra, which is what a thumbnail is.
 */

import type { CSSProperties, ReactNode } from "react";
import { DECK_THEME_COLOURS, type DeckSlide, type DeckTheme } from "@claude-bot/deck-model-contract";

/** One editable text region of a slide, named in the layout's own vocabulary. */
export interface SurfaceRegion {
  field: string;
  /** Present exactly when the field is a list. */
  index?: number;
}

export type SurfaceTextRenderer = (
  region: SurfaceRegion,
  value: string,
  placeholder: string,
  className: string,
) => ReactNode;

export interface SlideSurfaceProps {
  slide: DeckSlide;
  theme: DeckTheme;
  /** Render one text region. Default: the value as a span, nothing when empty. */
  text?: SurfaceTextRenderer;
  /** Controls appended inside a list item, after its text. Default: none. */
  itemChrome?: (field: string, index: number) => ReactNode;
  /** A trailing row appended to a list. Default: none. */
  listFoot?: (field: string) => ReactNode;
}

const plainText: SurfaceTextRenderer = (region, value, _placeholder, className) =>
  value ? (
    <span className={className} data-dkv-region={regionName(region)}>
      {value}
    </span>
  ) : null;

export function regionName(region: SurfaceRegion): string {
  return region.index === undefined ? region.field : `${region.field}:${region.index}`;
}

export function SlideSurface({ slide, theme, text = plainText, itemChrome, listFoot }: SlideSurfaceProps) {
  const colour = DECK_THEME_COLOURS[theme];
  const vars = {
    "--dkv-page": colour.page,
    "--dkv-ink": colour.ink,
    "--dkv-faint": colour.faint,
  } as CSSProperties;

  const list = (field: string, items: readonly string[]): ReactNode => (
    <ul className="dkv-sur-list" data-dkv-sur-list={field}>
      {items.map((item, index) => (
        <li className="dkv-sur-item" key={`${field}-${index}`}>
          {text({ field, index }, item, "点击输入", "dkv-sur-itemtext")}
          {itemChrome?.(field, index)}
        </li>
      ))}
      {listFoot?.(field)}
    </ul>
  );

  return (
    <div className="dkv-surface" data-dkv-surface={slide.layout} data-dkv-theme={theme} style={vars}>
      {slide.layout === "title" ? (
        <div className="dkv-sur-cover">
          {text({ field: "title" }, slide.title, "点击输入标题", "dkv-sur-title")}
          {text({ field: "subtitle" }, slide.subtitle, "点击输入副标题", "dkv-sur-subtitle")}
        </div>
      ) : (
        <div className="dkv-sur-body">
          {text({ field: "title" }, slide.title, "点击输入标题", "dkv-sur-heading")}
          {slide.layout === "bullets" ? list("bullets", slide.bullets) : null}
          {slide.layout === "two-column" ? (
            <div className="dkv-sur-columns">
              {list("left", slide.left)}
              {list("right", slide.right)}
            </div>
          ) : null}
          {slide.layout === "image-ref" ? (
            <>
              {/*
               * The same placeholder frame the Typst export prints: this
               * surface cannot resolve a ref any more than the contract can,
               * and a frame that says so is the honest rendering of "there is
               * an image here and this document cannot see it".
               */}
              <figure className="dkv-sur-image">
                <span className="dkv-sur-imgword">图片占位</span>
                {slide.image.alt ? <span className="dkv-sur-imgalt">{slide.image.alt}</span> : null}
                {slide.image.ref ? <code className="dkv-sur-imgref">{slide.image.ref}</code> : null}
              </figure>
              {text({ field: "caption" }, slide.caption, "点击输入图注", "dkv-sur-caption")}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
