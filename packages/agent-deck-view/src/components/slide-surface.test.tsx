/**
 * The slide surface: four layouts really laid out, and ONE rendering shared by
 * the thumbnail and the canvas.
 *
 * The consistency claim is structural, not visual: the strip and the canvas
 * mount the same `SlideSurface`, so for any slide the canvas must show exactly
 * the text the thumbnail shows, under the same layout attribute, in the same
 * theme colours. jsdom cannot measure a pixel, but it can prove the two are one
 * component with one opinion — which is the property that keeps the thumbnail
 * from becoming a lie about the canvas.
 */

import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  DECK_THEME_COLOURS,
  type DeckSlide,
  type DeckTheme,
} from "@claude-bot/deck-model-contract";
import { SlideCanvas } from "./SlideCanvas.js";
import { SlideSurface } from "./SlideSurface.js";

const SLIDES: readonly DeckSlide[] = [
  { id: "c", layout: "title", title: "年度回顾", subtitle: "工程团队" },
  { id: "b", layout: "bullets", title: "三件事", bullets: ["第一件", "第二件", "第三件"] },
  { id: "t", layout: "two-column", title: "对比", left: ["旧的做法"], right: ["新的做法"] },
  { id: "i", layout: "image-ref", title: "看图", image: { ref: "blob:9", alt: "架构图" }, caption: "整体架构" },
];

/** Every piece of user text a slide carries, for "nothing is dropped" checks. */
function textsOf(slide: DeckSlide): string[] {
  switch (slide.layout) {
    case "title":
      return [slide.title, slide.subtitle];
    case "bullets":
      return [slide.title, ...slide.bullets];
    case "two-column":
      return [slide.title, ...slide.left, ...slide.right];
    case "image-ref":
      return [slide.title, slide.image.alt, slide.image.ref, slide.caption];
  }
}

function surfaceOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".dkv-surface") as HTMLElement;
}

describe("SlideSurface", () => {
  it("renders every layout with all of its text, under its own layout attribute", () => {
    for (const slide of SLIDES) {
      const { container, unmount } = render(<SlideSurface slide={slide} theme="light" />);
      const surface = surfaceOf(container);
      expect(surface.getAttribute("data-dkv-surface")).toBe(slide.layout);
      for (const text of textsOf(slide)) {
        expect(surface.textContent, `${slide.layout} drops "${text}"`).toContain(text);
      }
      unmount();
    }
  });

  it("lays a bullets slide out as a real list, not a paragraph", () => {
    const { container } = render(<SlideSurface slide={SLIDES[1]!} theme="light" />);
    const items = container.querySelectorAll('[data-dkv-sur-list="bullets"] > .dkv-sur-item');
    expect([...items].map((item) => item.textContent)).toEqual(["第一件", "第二件", "第三件"]);
  });

  it("lays a two-column slide out as two lists", () => {
    const { container } = render(<SlideSurface slide={SLIDES[2]!} theme="light" />);
    expect(container.querySelector(".dkv-sur-columns")).not.toBeNull();
    expect(container.querySelector('[data-dkv-sur-list="left"]')).toHaveTextContent("旧的做法");
    expect(container.querySelector('[data-dkv-sur-list="right"]')).toHaveTextContent("新的做法");
  });

  it("renders an image slide as the placeholder frame the export prints", () => {
    const { container } = render(<SlideSurface slide={SLIDES[3]!} theme="light" />);
    const figure = container.querySelector(".dkv-sur-image") as HTMLElement;
    expect(figure).toHaveTextContent("图片占位");
    expect(figure).toHaveTextContent("架构图");
    expect(figure).toHaveTextContent("blob:9");
    expect(container.querySelector(".dkv-sur-caption")).toHaveTextContent("整体架构");
  });

  it("carries the CONTRACT's theme colours for both themes, inline", () => {
    for (const theme of ["light", "dark"] as DeckTheme[]) {
      const { container, unmount } = render(<SlideSurface slide={SLIDES[0]!} theme={theme} />);
      const surface = surfaceOf(container);
      expect(surface.getAttribute("data-dkv-theme")).toBe(theme);
      expect(surface.style.getPropertyValue("--dkv-page")).toBe(DECK_THEME_COLOURS[theme].page);
      expect(surface.style.getPropertyValue("--dkv-ink")).toBe(DECK_THEME_COLOURS[theme].ink);
      expect(surface.style.getPropertyValue("--dkv-faint")).toBe(DECK_THEME_COLOURS[theme].faint);
      unmount();
    }
  });

  it("shows an empty slide as an empty page, not as placeholder prose", () => {
    const empty: DeckSlide = { id: "e", layout: "bullets", title: "", bullets: [] };
    const { container } = render(<SlideSurface slide={empty} theme="light" />);
    // The default renderer draws nothing for an empty region: a thumbnail of a
    // blank slide is a blank page. The INVITATION to type belongs to the
    // canvas's editable renderer, not to a picture.
    expect(surfaceOf(container).textContent).toBe("");
  });
});

describe("the thumbnail and the canvas are one rendering", () => {
  it("shows the same text under the same layout for every slide, both themes", () => {
    for (const slide of SLIDES) {
      for (const theme of ["light", "dark"] as DeckTheme[]) {
        const thumb = render(<SlideSurface slide={slide} theme={theme} />);
        const thumbSurface = surfaceOf(thumb.container);
        const canvas = render(
          <SlideCanvas
            title="画布"
            slide={slide}
            theme={theme}
            index={0}
            count={1}
            editable={true}
            pending={0}
            notice={null}
            hint=""
            onText={vi.fn()}
            onAddItem={vi.fn()}
            onRemoveItem={vi.fn()}
            onMoveItem={vi.fn()}
            onInsertSlide={vi.fn()}
            onTheme={vi.fn()}
          />,
        );
        const canvasSurface = canvas.container.querySelector(".dkv-canvas .dkv-surface") as HTMLElement;

        expect(canvasSurface.getAttribute("data-dkv-surface")).toBe(thumbSurface.getAttribute("data-dkv-surface"));
        expect(canvasSurface.getAttribute("data-dkv-theme")).toBe(thumbSurface.getAttribute("data-dkv-theme"));
        expect(canvasSurface.style.getPropertyValue("--dkv-page")).toBe(
          thumbSurface.style.getPropertyValue("--dkv-page"),
        );
        // Every region the thumbnail shows, the canvas shows — same field, same
        // text — and the canvas adds nothing except its editing chrome.
        for (const region of thumbSurface.querySelectorAll("[data-dkv-region]")) {
          const name = region.getAttribute("data-dkv-region")!;
          const twin = canvasSurface.querySelector(`[data-dkv-region="${name}"]`);
          expect(twin, `${slide.layout} canvas lacks region ${name}`).not.toBeNull();
          expect(twin!.textContent).toBe(region.textContent);
        }
        cleanup();
      }
    }
  });
});
