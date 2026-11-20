/** Scoped lifecycle for a lab Runner started through docker exec. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [command, scanInput, bundleInput] = process.argv.slice(2);
if (!["start", "stop"].includes(command) || !scanInput || !bundleInput) throw new Error("start|stop <lab-scan-home> <bundle>");
const scan = path.resolve(scanInput), bundle = path.resolve(bundleInput);
const marker = path.resolve(scan, "../..", ".refactor-lab");
if (!fs.existsSync(marker) || !fs.existsSync(path.join(scan, "environment.json"))) throw new Error("Refusing an unmarked Runner");
const pidFile = path.join(scan, "process.json");
function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (fields[0] === "Z" || fs.statSync(`/proc/${pid}`).uid !== process.getuid()
      || argv[1] !== bundle || argv[2] !== "daemon") return null;
    return { pid, started: fields[19], bundle };
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
}
function owned(record) { const live = identity(record.pid); return live && live.started === record.started && record.bundle === bundle; }
const prior = fs.existsSync(pidFile) ? JSON.parse(fs.readFileSync(pidFile, "utf8")) : null;
if (command === "stop") {
  if (prior && owned(prior)) {
    process.kill(prior.pid, "SIGTERM");
    const deadline = Date.now() + 30000;
    while (owned(prior) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (owned(prior)) throw new Error("Lab Runner did not drain; no other process was signalled");
  }
} else {
  if (prior && owned(prior)) throw new Error("Lab Runner already running");
  const environment = JSON.parse(fs.readFileSync(path.join(scan, "environment.json"), "utf8"));
  const child = spawn(process.execPath, [bundle, "daemon"], { cwd: scan, stdio: "inherit", env: { ...process.env, ...environment } });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  let record;
  for (let attempt = 0; attempt < 20 && !record; attempt++) {
    record = identity(child.pid);
    if (!record) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!record) { child.kill("SIGTERM"); throw new Error("Could not establish lab Runner process identity"); }
  fs.writeFileSync(pidFile, JSON.stringify(record), { mode: 0o600 });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { if (owned(record)) child.kill(signal); });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
