import { randomUUID, createHash } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";

/** Install explicitly in a project's workspace; render metrics with the built-in table. */
export async function activate({ history, platform }) {
  const source = history.path("metrics.json");
  let reference = "", pending, timer, watcher, closed = false;
  const read = () => JSON.parse(history.read("metrics.json"));
  const toolSpecs = [
    { name: "read_metrics", description: "Read the real workspace metrics file", readOnly: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      invoke: () => read() },
    { name: "write_metrics", description: "Replace the real metrics file and publish its current projection", readOnly: false,
      inputSchema: { type: "object", properties: { metrics: { type: "object", additionalProperties: { type: "number" } } }, required: ["metrics"], additionalProperties: false },
      invoke: async ({ metrics }) => { history.write("metrics.json", JSON.stringify(metrics, null, 2) + "\n"); await publish(); return { ref: reference, metrics }; } },
  ];
  const registered = await platform("adapter_register", {
    request: "workspace-metrics-plugin-v1", attach: false,
    data: { title: "实验指标", source, entry: "metrics-plugin.mjs",
      schema: { view: "metrics", columns: [{ key: "metric", label: "指标" }, { key: "value", label: "数值", kind: "number" }] },
      tools: toolSpecs.map(({ invoke, readOnly, ...schema }) => schema) },
  });
  reference = registered.ref;
  async function update() {
    if (closed) return;
    const current = await platform("ref_describe", { ref: reference });
    const resource = current.resource;
    if (!resource || resource.data.adapter.status === "removed") return;
    if (resource.data.adapter.status === "paused") return;
    const metrics = read(), serialized = JSON.stringify(metrics);
    await platform("adapter_publish", {
      request: randomUUID(), node: resource.id, version: resource.version,
      data: { sourceRevision: createHash("sha256").update(serialized).digest("hex"),
        rows: Object.entries(metrics).map(([metric, value]) => ({ id: metric, cells: { metric, value } })) },
    });
  }
  function publish() { const result = (pending ?? Promise.resolve()).then(update); pending = result.catch(() => {}); return result; }
  await publish();
  watcher = watch(dirname(source), { persistent: false }, (_event, name) => {
    if (name && name.toString() !== basename(source)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void publish().catch(error => process.stderr.write("Metrics projection failed: " + error.message + "\n")); }, 250);
  });
  watcher.on("error", error => process.stderr.write("Metrics watcher failed: " + error.message + "\n"));
  return {
    refs: [{ ref: reference, tools: toolSpecs }],
    close: async () => { closed = true; clearTimeout(timer); watcher.close(); await pending; },
  };
}
