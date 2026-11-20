import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeCodexProcess, trackCodexProcess } from "./codex-owned-process.js";

// The npm launcher + native writer is the failure observed in real split recovery.
describe.skipIf(process.platform !== "linux")("owned Codex process lifetime", () => {
  it.each(["exit", "SIGTERM", "SIGINT"])("releases private writers on Runner %s even when async cleanup never finishes", async (mode) => {
    const moduleUrl = new URL("./codex-owned-process.ts", import.meta.url).href;
    const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { spawn } from 'node:child_process';
      import { trackCodexProcess } from ${JSON.stringify(moduleUrl)};
      const writer=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});
      trackCodexProcess(writer,true);
      process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0));
      writer.stdout.once('data',()=>{process.stdout.write(String(writer.pid)+'\\n');${mode === "exit" ? "setTimeout(()=>process.exit(0),50)" : ""}});
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const pid = await new Promise<number>((resolve, reject) => {
      owner.stdout.once("data", value => resolve(Number(String(value).trim()))); owner.once("error", reject);
    });
    try {
      const ended = new Promise<void>(resolve => owner.once("exit", () => resolve()));
      if (mode !== "exit") owner.kill(mode as NodeJS.Signals);
      await ended;
      await expect.poll(() => {
        try { return readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z "); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      }).toBe(true);
    } finally { owner.kill("SIGKILL"); try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ } }
  });

  it("reaps a native writer when its launcher exits before cleanup", async () => {
    const wrapper = spawn(process.execPath, ["-e", `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',()=>{process.stdout.write(String(child.pid)+'\\n');setTimeout(()=>process.exit(0),30)});
    `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    trackCodexProcess(wrapper, true);
    const nativePid = await new Promise<number>((resolve, reject) => {
      wrapper.stdout.once("data", value => resolve(Number(String(value).trim())));
      wrapper.once("error", reject);
    });
    try {
      await new Promise<void>(resolve => wrapper.once("exit", () => resolve()));
      await closeCodexProcess(wrapper, true);
      await expect.poll(() => {
        try { return readFileSync(`/proc/${nativePid}/stat`, "utf8").includes(") Z "); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      }).toBe(true);
    } finally { try { process.kill(-wrapper.pid!, "SIGKILL"); } catch { /* gone */ } }
  });

  it("reaps an unresponsive native writer below a launcher before returning", async () => {
    const code = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
      process.on('SIGTERM',()=>{});
      child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\\n'));
    `;
    const wrapper = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const nativePid = await new Promise<number>((resolve, reject) => {
      wrapper.stdout.once("data", value => resolve(Number(String(value).trim())));
      wrapper.once("error", reject);
    });
    try {
      await closeCodexProcess(wrapper, true);
      expect(wrapper.exitCode !== null || wrapper.signalCode !== null).toBe(true);
      let live = true;
      try { live = !readFileSync(`/proc/${nativePid}/stat`, "utf8").includes(") Z "); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") live = false; else throw error; }
      expect(live).toBe(false);
    } finally {
      try { process.kill(-wrapper.pid!, "SIGKILL"); } catch { /* group already reaped */ }
    }
  });
});
