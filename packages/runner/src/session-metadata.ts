import fs from "node:fs/promises";
import { parseSessionText, type Source } from "@claude-bot/plugin-sessions/scan";

/** Input routing needs the native identity/cwd header, never conversation bodies. */
export async function readSessionInputMetadata(file: string, source: Source) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let prefix = buffer.toString("utf8", 0, bytesRead);
    if (bytesRead === buffer.length) {
      const end = prefix.lastIndexOf("\n");
      if (end < 0) throw new Error("会话头部过大，无法核实输入目标；尚未发送消息");
      prefix = prefix.slice(0, end + 1);
    }
    return parseSessionText(source, prefix).meta;
  } finally { await handle.close(); }
}
