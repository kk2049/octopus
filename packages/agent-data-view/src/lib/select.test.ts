/**
 * The readers, tested against the shapes a real projection actually has —
 * including the malformed ones, because the point of returning a status instead
 * of throwing is that a component can render the difference.
 */

import { describe, expect, it } from "vitest";
import {
  displayValue,
  findRecord,
  initialFieldValue,
  readActionSpecs,
  readFacts,
  readFieldSpecs,
  readNotice,
  readRecord,
  readRows,
  readSections,
  readThread,
  selectPath,
  type RowKeys,
} from "./select.js";

const KEYS: RowKeys = { id: "id", title: "title", subtitle: "subtitle", badge: "badge", tone: "tone" };

describe("readActionSpecs", () => {
  const projected = [
    { action: "add_note", label: "新建", fields: "forms.add", submit_label: "保存" },
    { action: "delete_all", label: "删除全部", fields: "forms.delete" },
    { action: "add_note", label: "重复项", fields: "forms.other" },
  ];

  it("allows only composition-reviewed ids and removes duplicates", () => {
    expect(readActionSpecs(projected, "add_note", 12)).toEqual({
      status: "ok",
      actions: [{
        action: "add_note", label: "新建", fields: "forms.add", title: "新建", submitLabel: "保存", hint: "",
        contextParam: "",
      }],
    });
  });

  it("carries a declared context_param through, trimmed", () => {
    const menu = [{ action: "mark_seen", label: "标记已阅", fields: "forms.seen", context_param: " report_id " }];
    expect(readActionSpecs(menu, "mark_seen", 12).actions[0]!.contextParam).toBe("report_id");
  });

  it("separates a missing menu from a malformed one", () => {
    expect(readActionSpecs(undefined, "add_note", 12).status).toBe("missing");
    expect(readActionSpecs({}, "add_note", 12).status).toBe("not_a_collection");
  });
});

describe("selectPath", () => {
  const projection = { inbox: { items: [{ id: "a" }, { id: "b" }] }, count: 2, nothing: null };

  it("walks own object keys and array indices", () => {
    expect(selectPath(projection, "count")).toBe(2);
    expect(selectPath(projection, "inbox.items.1")).toEqual({ id: "b" });
  });

  it("answers undefined for a path that is not there", () => {
    expect(selectPath(projection, "outbox")).toBeUndefined();
    expect(selectPath(projection, "inbox.items.9")).toBeUndefined();
    expect(selectPath(projection, "count.deeper")).toBeUndefined();
    expect(selectPath(projection, "")).toBeUndefined();
  });

  it("distinguishes a null the projection contains from an absent path", () => {
    expect(selectPath(projection, "nothing")).toBeNull();
    expect(selectPath(projection, "missing")).toBeUndefined();
  });

  it("never reaches the prototype chain", () => {
    expect(selectPath(projection, "__proto__")).toBeUndefined();
    expect(selectPath(projection, "constructor")).toBeUndefined();
    expect(selectPath(projection, "inbox.toString")).toBeUndefined();
    // An inherited property is not an own property, even without the deny-list.
    expect(selectPath(Object.create({ inherited: 1 }) as object, "inherited")).toBeUndefined();
  });

  it("indexes arrays only with a canonical decimal", () => {
    expect(selectPath({ rows: ["x"] }, "rows.00")).toBeUndefined();
    expect(selectPath({ rows: ["x"] }, "rows.length")).toBeUndefined();
  });
});

describe("readRows", () => {
  it("reads an array of records", () => {
    const set = readRows(
      [{ id: "a", title: "第一条", subtitle: "s", badge: "新", tone: "warn" }],
      KEYS,
      10,
    );
    expect(set.status).toBe("ok");
    expect(set.rows).toEqual([
      { id: "a", title: "第一条", subtitle: "s", badge: "新", tone: "warn", record: expect.any(Object) },
    ]);
  });

  it("reads an object map, keying rows by the map key", () => {
    const set = readRows({ a: { title: "A" }, b: { title: "B" } }, KEYS, 10);
    expect(set.rows.map((row) => [row.id, row.title])).toEqual([
      ["a", "A"],
      ["b", "B"],
    ]);
  });

  it("reads an array of scalars", () => {
    const set = readRows(["x", 2], KEYS, 10);
    expect(set.rows.map((row) => row.title)).toEqual(["x", "2"]);
    expect(set.rows[0]!.record).toBeNull();
  });

  it("separates a missing path from an empty collection", () => {
    expect(readRows(undefined, KEYS, 10).status).toBe("missing");
    expect(readRows([], KEYS, 10).status).toBe("ok");
    expect(readRows("nope", KEYS, 10).status).toBe("not_a_collection");
  });

  it("reads up to the limit, says more exist and counts the whole collection", () => {
    const set = readRows([{ id: "a" }, { id: "b" }, { id: "c" }], KEYS, 2);
    expect(set.rows).toHaveLength(2);
    expect(set.truncated).toBe(true);
    expect(set.total).toBe(3);
    expect(readRows({ a: {}, b: {} }, KEYS, 10)).toMatchObject({ truncated: false, total: 2 });
  });

  it("falls back to the index when a row has no id, and never emits a blank one", () => {
    const set = readRows([{ title: "无 id" }, {}], KEYS, 10);
    expect(set.rows.map((row) => row.id)).toEqual(["0", "1"]);
  });

  it("refuses an unknown tone rather than passing it through", () => {
    expect(readRows([{ id: "a", tone: "chartreuse" }], KEYS, 10).rows[0]!.tone).toBe("neutral");
  });

  it("honours renamed keys", () => {
    const set = readRows([{ slug: "s", name: "N" }], { ...KEYS, id: "slug", title: "name" }, 10);
    expect(set.rows[0]).toMatchObject({ id: "s", title: "N" });
  });
});

describe("displayValue", () => {
  it("renders scalars and lists of scalars, and refuses nested objects", () => {
    expect(displayValue("x")).toBe("x");
    expect(displayValue(3)).toBe("3");
    expect(displayValue(true)).toBe("是");
    expect(displayValue(null)).toBe("");
    expect(displayValue(["a", 1])).toBe("a、1");
    expect(displayValue({ a: 1 })).toBeNull();
    expect(displayValue([{ a: 1 }])).toBeNull();
    expect(displayValue(Number.NaN)).toBe("");
  });
});

describe("findRecord / readRecord", () => {
  const rows = [{ id: "a", n: 1 }, { id: "b", n: 2 }];

  it("finds by id in an array", () => {
    expect(findRecord(rows, "id", "b")).toEqual({ record: { id: "b", n: 2 }, status: "ok" });
  });

  it("finds by map key and by inner id", () => {
    expect(findRecord({ a: { n: 1 } }, "id", "a").status).toBe("ok");
    expect(findRecord({ first: { id: "x" } }, "id", "x").status).toBe("ok");
  });

  it("says not_found rather than returning the first row", () => {
    expect(findRecord(rows, "id", "zzz")).toEqual({ record: null, status: "not_found" });
  });

  it("separates a missing path from a value that is not a record", () => {
    expect(readRecord(undefined).status).toBe("missing");
    expect(readRecord([1, 2]).status).toBe("not_a_record");
    expect(readRecord({ a: 1 })).toEqual({ record: { a: 1 }, status: "ok" });
  });
});

describe("readFacts", () => {
  const record = { id: "a", title: "T", body: "b", who: "lht", n: 4, nested: { deep: 1 } };

  it("lists every scalar field except the ones the panel already shows", () => {
    expect(readFacts(record, undefined, ["id", "title", "body"], 32)).toEqual([
      { key: "who", label: "who", value: "lht" },
      { key: "n", label: "n", value: "4" },
    ]);
  });

  it("omits a nested object instead of stringifying it", () => {
    const facts = readFacts(record, undefined, [], 32);
    expect(facts.some((fact) => fact.key === "nested")).toBe(false);
  });

  it("honours an explicit list and an explicit label map", () => {
    expect(readFacts(record, ["who"], [], 32)).toEqual([{ key: "who", label: "who", value: "lht" }]);
    expect(readFacts(record, { who: "负责人" }, [], 32)).toEqual([
      { key: "who", label: "负责人", value: "lht" },
    ]);
  });

  it("caps at the limit", () => {
    expect(readFacts(record, undefined, [], 2)).toHaveLength(2);
  });
});

describe("readFieldSpecs", () => {
  it("reads the engine `params` map shape", () => {
    const set = readFieldSpecs(
      { title: { type: "string", required: true, description: "标题" }, note: { type: "text" } },
      8,
    );
    expect(set.status).toBe("ok");
    expect(set.fields).toEqual([
      { name: "title", label: "title", type: "string", required: true, description: "标题", options: [] },
      { name: "note", label: "note", type: "text", required: false, description: "", options: [] },
    ]);
  });

  it("reads an array with explicit order", () => {
    const set = readFieldSpecs([{ name: "b" }, { name: "a" }], 8);
    expect(set.fields.map((field) => field.name)).toEqual(["b", "a"]);
  });

  it("reads a bare type string", () => {
    expect(readFieldSpecs({ n: "number" }, 8).fields[0]).toMatchObject({ name: "n", type: "number" });
  });

  it("reads an enum into options", () => {
    expect(readFieldSpecs({ s: { type: "string", enum: ["a", 2] } }, 8).fields[0]!.options).toEqual(["a", "2"]);
  });

  it("separates missing from malformed", () => {
    expect(readFieldSpecs(undefined, 8).status).toBe("missing");
    expect(readFieldSpecs("nope", 8).status).toBe("not_a_declaration");
    expect(readFieldSpecs({}, 8).status).toBe("not_a_declaration");
    expect(readFieldSpecs({ a: { type: "object" } }, 8).status).toBe("not_a_declaration");
    expect(readFieldSpecs({ a: { type: "string", enum: [{ x: 1 }] } }, 8).status).toBe("not_a_declaration");
    expect(readFieldSpecs([{ noName: 1 }], 8).status).toBe("not_a_declaration");
  });

  it("refuses a declaration wider than the transport rather than truncating it", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 9; index += 1) wide[`f${index}`] = { type: "string" };
    const set = readFieldSpecs(wide, 8);
    expect(set.status).toBe("too_wide");
    expect(set.fields).toHaveLength(0);
  });
});

describe("readNotice", () => {
  it("reads a {tone, text} banner and defaults an unknown tone to info", () => {
    expect(readNotice({ tone: "warn", text: "有 2 份待阅" })).toEqual({ tone: "warn", text: "有 2 份待阅" });
    expect(readNotice({ tone: "loud", text: "x" })).toEqual({ tone: "info", text: "x" });
  });

  it("answers null for absence, null and every malformed shape alike", () => {
    expect(readNotice(undefined)).toBeNull();
    expect(readNotice(null)).toBeNull();
    expect(readNotice("加油")).toBeNull();
    expect(readNotice({ tone: "warn" })).toBeNull();
    expect(readNotice({ text: "   " })).toBeNull();
    expect(readNotice([{ text: "x" }])).toBeNull();
  });
});

describe("readThread", () => {
  it("reads chronological entries and skips malformed rows without dropping the rest", () => {
    const set = readThread(
      [
        { by: "lht", at: "08-13 09:00", text: "提交了汇报", badge: "提交", tone: "info" },
        "not a record",
        { by: "bob", at: "08-13 10:00", text: "同意" },
      ],
      200,
    );
    expect(set.status).toBe("ok");
    expect(set.truncated).toBe(false);
    expect(set.entries).toHaveLength(2);
    expect(set.entries[0]).toMatchObject({ by: "lht", badge: "提交", tone: "info" });
    expect(set.entries[1]).toMatchObject({ by: "bob", tone: "neutral" });
  });

  it("separates a missing field from an empty history and a wrong shape", () => {
    expect(readThread(undefined, 10).status).toBe("missing");
    expect(readThread(null, 10)).toEqual({ entries: [], truncated: false, total: 0, status: "ok" });
    expect(readThread([], 10)).toEqual({ entries: [], truncated: false, total: 0, status: "ok" });
    expect(readThread({ a: 1 }, 10).status).toBe("not_a_collection");
  });

  it("caps the entries and says it truncated", () => {
    const set = readThread(
      Array.from({ length: 5 }, (_, index) => ({ by: "x", at: String(index), text: "t" })),
      3,
    );
    expect(set.entries).toHaveLength(3);
    expect(set.truncated).toBe(true);
    expect(set.total).toBe(5);
    // Malformed rows are skipped, not counted, wherever they sit.
    expect(readThread([{ at: "1" }, 7, { at: "2" }, null, { at: "3" }], 2)).toMatchObject({ truncated: true, total: 3 });
  });

  it("keys entries by their own id when the fold minted one", () => {
    const set = readThread([{ id: "c-1", by: "x", at: "t", text: "" }], 10);
    expect(set.entries[0]!.id).toBe("c-1");
  });
});

describe("readSections", () => {
  const record = { id: "r1", evidence: "- 文件 A", coverage: "", decision: 42 };

  it("renders only named fields that hold non-empty text", () => {
    expect(readSections(record, { evidence: "证据快照", coverage: "覆盖", decision: "结论", nope: "无" }, 8)).toEqual([
      { key: "evidence", title: "证据快照", body: "- 文件 A" },
    ]);
  });

  it("accepts the bare-array spelling and answers nothing for no spec or no record", () => {
    expect(readSections(record, ["evidence"], 8)).toEqual([{ key: "evidence", title: "evidence", body: "- 文件 A" }]);
    expect(readSections(record, undefined, 8)).toEqual([]);
    expect(readSections(null, ["evidence"], 8)).toEqual([]);
  });
});

describe("initialFieldValue", () => {
  it("seeds a checkbox false, a required select with its first option, and everything else blank", () => {
    expect(initialFieldValue({ name: "b", label: "b", type: "boolean", required: false, description: "", options: [] }))
      .toBe("false");
    expect(
      initialFieldValue({ name: "s", label: "s", type: "string", required: true, description: "", options: ["x", "y"] }),
    ).toBe("x");
    expect(
      initialFieldValue({ name: "s", label: "s", type: "string", required: false, description: "", options: ["x"] }),
    ).toBe("");
    expect(initialFieldValue({ name: "t", label: "t", type: "string", required: true, description: "", options: [] }))
      .toBe("");
  });
});
