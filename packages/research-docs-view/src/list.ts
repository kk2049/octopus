import { LIST_PAGE_ENTRIES, type Call } from "@claude-bot/research-docs-contract";
/**
 * Reads a whole list (`library` pages, `comments` of one document) one bounded
 * page per call, following `next` to its end. The list has no length limit;
 * each answer does. Returns null once `live()` turns false (a newer read or an
 * unmounted panel owns the result).
 */
export async function readAll<T>(
  call: Call,
  action: "library" | "comments",
  key: "pages" | "comments",
  params: Record<string, unknown>,
  live: () => boolean,
): Promise<T[] | null> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await call<Record<string, unknown>>(action, {
      ...params,
      limit: LIST_PAGE_ENTRIES,
      ...(after ? { after } : {}),
    });
    if (!live()) return null;
    const items = page[key],
      next = page.next;
    if (!Array.isArray(items) || (next !== null && typeof next !== "string"))
      throw new Error("分页读取回执异常，请刷新页面");
    rows.push(...(items as T[]));
    if (next === null) return rows;
    if (next === after || !items.length)
      throw new Error("分页读取回执异常，请刷新页面");
    after = next;
  }
}
