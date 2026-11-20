import path from "node:path";
import { readPrivateRegistration, registrationFiles, capabilityRegistryDirectory,
  writeCapabilityRegistration, removeCapabilityRegistration } from "./capability-registry.js";

/** Device-owner management only; it writes private desired state, never dispatches a remote command. */
export async function capabilityCommand(home: string, args: string[]): Promise<void> {
  const [action, name, expected] = args;
  if (action === "list") {
    const rows = [];
    for (const file of await registrationFiles(home)) {
      try {
        const { value, digest } = await readPrivateRegistration(path.join(capabilityRegistryDirectory(home), file));
        rows.push({ id: value.id, title: value.title, version: value.version, enabled: value.enabled, digest });
      } catch { rows.push({ id: file.slice(0, -5), error: "invalid_config" }); }
    }
    console.log(JSON.stringify({ configured: rows, live_status: "Octopus Dashboard → Runner capabilities" }, null, 2));
    return;
  }
  if (action === "register" && name) {
    const { value } = await readPrivateRegistration(path.resolve(name));
    const digest = await writeCapabilityRegistration(home, value, expected ?? "absent");
    console.log(JSON.stringify({ id: value.id, digest, reconciliation: "within 2 seconds plus provider startup" }));
    return;
  }
  if (["reload", "enable", "disable", "remove"].includes(action ?? "") && name && expected) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) throw new Error("Invalid provider id");
    if (action === "remove") { await removeCapabilityRegistration(home, name, expected); console.log(JSON.stringify({ removed: name })); return; }
    const { value, digest } = await readPrivateRegistration(path.join(capabilityRegistryDirectory(home), name + ".json"));
    if (digest !== expected) throw new Error("Registration changed");
    const next = await writeCapabilityRegistration(home, { ...value, enabled: action === "reload" ? value.enabled : action === "enable" }, expected);
    console.log(JSON.stringify({ id: name, digest: next }));
    return;
  }
  throw new Error("Usage: capabilities list | register <private-manifest.json> [current-digest] | reload|enable|disable|remove <id> <current-digest>");
}
