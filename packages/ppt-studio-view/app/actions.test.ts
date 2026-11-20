import { describe, expect, it } from "vitest";
import { deck_command, load_skill, replace_deck } from "./actions.js";
import { project } from "./projection.js";

const ctx = { now: "2026-08-13T00:00:00.000Z", state: project([]) };

describe("PPT Studio backend actions", () => {
  it("injects one selected skill without putting its text into durable state", () => {
    const answer = load_skill(ctx, { name: "strategy" });
    expect(answer.result.instructions).toContain("叙事弧");
    expect(answer.events).toEqual([{
      type: "skill_loaded",
      data: { name: "strategy" },
      at: ctx.now,
      by: "ppt-studio",
    }]);
    expect(JSON.stringify(answer.events)).not.toContain("叙事弧");
  });

  it("accepts only a bounded deck-model/v1 document", () => {
    const deck = {
      schema: "deck-model/v1",
      title: "发布会",
      theme: "dark",
      slides: [{ id: "s1", layout: "title", title: "结论", subtitle: "一句话" }],
    };
    expect(replace_deck(ctx, { deck_json: JSON.stringify(deck) }).result).toEqual({ slides: 1 });
    expect(() => replace_deck(ctx, { deck_json: JSON.stringify({ ...deck, schema: "evil/v1" }) }))
      .toThrow(/wrong schema/);
    expect(() => replace_deck(ctx, { deck_json: JSON.stringify({ ...deck, slides: [deck.slides[0], deck.slides[0]] }) }))
      .toThrow(/duplicate/);
  });

  it("applies the same semantic command the visual editor emits", () => {
    const answer = deck_command(ctx, { op: "set_text", slide: "s1", field: "title", value: "新标题" });
    expect(answer.events[0].data.deck.slides[0].title).toBe("新标题");
  });
});
