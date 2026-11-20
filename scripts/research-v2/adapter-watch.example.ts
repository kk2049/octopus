/** Run this module inside the already-authorized Runner workspace. */
export const register = {
  title: "ACC 评测指标",
  summary: "把受控 metrics.json 的标量行投影到研究画布",
  schema: { view: "metrics", columns: [{ key: "name", label: "指标" }, { key: "value", label: "值", kind: "number" as const }], primary: "name" },
};
export function project(input: { text: string }) {
  const value = JSON.parse(input.text) as Record<string, number>;
  return Object.entries(value).map(([name, metric]) => ({ id: name, cells: { name, value: metric } }));
}
