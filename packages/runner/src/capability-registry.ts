import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { hardenWindowsPath, windowsPrivatePathIsRestricted } from "./install-config.js";
import { capabilityId, CAPABILITY_LIMITS, jsonObject } from "./capability-protocol.js";

export interface CapabilityRegistration {
  schema: "runner-capability-registration/v1";
  id: string;
  title: string;
  version: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
  generation?: string;
}
export function parseCapabilityRegistration(value: unknown): CapabilityRegistration {
  if (!jsonObject(value) || value.schema !== "runner-capability-registration/v1" || !capabilityId(value.id)
    || typeof value.title !== "string" || !value.title || value.title.length > 120
    || typeof value.version !== "string" || !value.version || value.version.length > 80
    || typeof value.command !== "string" || !path.isAbsolute(value.command) || value.command.length > 4096
    || !Array.isArray(value.args) || value.args.length > 64 || value.args.some(x => typeof x !== "string" || x.length > 4096)
    || (value.cwd !== undefined && (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)))
    || (value.enabled !== undefined && typeof value.enabled !== "boolean")
    || Object.keys(value).some(key => !["schema", "id", "title", "version", "command", "args", "cwd", "env", "enabled", "generation"].includes(key))) throw new Error("Invalid capability registration");
  if (value.generation !== undefined && (typeof value.generation !== "string" || !/^[a-f0-9-]{36}$/.test(value.generation))) throw new Error("Invalid registration generation");
  if (value.env !== undefined && (!jsonObject(value.env) || Object.keys(value.env).length > 64
    || Object.entries(value.env).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.length > 8192))) throw new Error("Invalid capability environment");
  return { schema: "runner-capability-registration/v1", id: value.id, title: value.title, version: value.version,
    ...(value.generation ? { generation: value.generation as string } : {}),
    command: value.command, args: value.args as string[], enabled: value.enabled !== false,
    ...(value.cwd ? { cwd: value.cwd as string } : {}), ...(value.env ? { env: value.env as Record<string, string> } : {}) };
}
export function capabilityRegistryDirectory(home: string): string { return path.join(home, ".octopus", "runner", "capabilities"); }
export async function readPrivateRegistration(file: string): Promise<{ value: CapabilityRegistration; digest: string }> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 || (process.platform === "win32" && !windowsPrivatePathIsRestricted(file)) || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Capability registration must be a private, owner-held regular file");
    const data = await handle.readFile("utf8");
    return { value: parseCapabilityRegistration(JSON.parse(data)), digest: createHash("sha256").update(data).digest("hex") };
  } finally { await handle.close(); }
}
export async function registrationFiles(home: string): Promise<string[]> {
  try {
    const entries = await readdir(capabilityRegistryDirectory(home), { withFileTypes: true });
    const files = entries.filter(row => row.name.endsWith(".json")).map(row => row.name).sort();
    if (files.length > CAPABILITY_LIMITS.providers) throw new Error("Capability provider limit reached");
    return files;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** Local operator only. CAS prevents one CLI update from silently overwriting another. */
export async function writeCapabilityRegistration(home: string, value: CapabilityRegistration, expected: string | "absent"): Promise<string> {
  const parsed = parseCapabilityRegistration(value);
  const dir = capabilityRegistryDirectory(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenWindowsPath(dir, true);
  const lock = await open(path.join(dir, ".write-lock"), "wx", 0o600);
  const file = path.join(dir, parsed.id + ".json");
  const temp = path.join(dir, "." + randomUUID() + ".tmp");
  try {
    let digest = "absent";
    try { digest = (await readPrivateRegistration(file)).digest; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (digest !== expected) throw new Error("Registration changed; list again and supply its current digest");
    if (digest === "absent" && (await registrationFiles(home)).length >= CAPABILITY_LIMITS.providers) throw new Error("Capability provider limit reached");
    const data = JSON.stringify({ ...parsed, generation: randomUUID() }, null, 2) + "\n";
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    return createHash("sha256").update(data).digest("hex");
  } finally { await unlink(temp).catch(() => undefined); await lock.close(); await unlink(path.join(dir, ".write-lock")); }
}
export async function removeCapabilityRegistration(home: string, id: string, expected: string): Promise<void> {
  if (!capabilityId(id)) throw new Error("Invalid provider id");
  const dir = capabilityRegistryDirectory(home);
  const lock = await open(path.join(dir, ".write-lock"), "wx", 0o600);
  try {
    const file = path.join(dir, id + ".json");
    if ((await readPrivateRegistration(file)).digest !== expected) throw new Error("Registration changed");
    await unlink(file);
  } finally { await lock.close(); await unlink(path.join(dir, ".write-lock")); }
}
