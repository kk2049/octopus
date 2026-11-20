/**
 * factory projection — the save audit trail. file_saved events are appended
 * by the kernel's /api/factory/save route with the SAVER's identity, so "who
 * changed which app file when" is one fold away.
 */

interface Ev {
  seq: number;
  at: string;
  by: string;
  type: string;
  data: Record<string, unknown>;
}

const who = (by: string): string => by.replace(/^user:/, "").replace(/^agent:/, "🤖");

export function project(events: readonly Ev[]): Record<string, unknown> {
  const saves = events.filter((e) => e.type === "file_saved");
  return {
    history: saves
      .slice(-30)
      .reverse()
      .map((e) => ({
        id: `s-${e.seq}`,
        title: `${String(e.data.app)}/${String(e.data.file)}`,
        subtitle: `${who(e.by)} · ${e.at.slice(5, 16).replace("T", " ")}`,
        badge: `${e.data.bytes} B`,
      })),
    stats: { 保存次数: saves.length },
    hint:
      "这里是工厂的审计面。左侧 /factory 页面上的每次保存、建筑师 agent 的每次改动，都以保存者署名落在这条日志里。",
  };
}
