import { expect, it } from "vitest";
import type { AgentExecutableStatus } from "./agent-executables.js";
import { executableRecovery } from "./agent-executable-recovery.js";

function state(): AgentExecutableStatus {
  return { provider: "codex", reason: "unsafe_permissions", candidates: [{ entry: "/home/chris/.local/bin/codex", source: "standard", preferred: false }],
    detail: { stage: "entry", path: "/home/chris/.local/bin", uid: 1002, gid: 1002, mode: "0775", rule: "group_writable" } };
}
it("provides a conditional exact-path repair and a separate explicit shared-installation choice", () => {
  const out = executableRecovery(state(), undefined, 1002)!;
  expect(out.repair?.command).toBe("chmod g-w -- '/home/chris/.local/bin'");
  expect(out.trust?.command).toBe("octopus-runner agents bind codex '/home/chris/.local/bin/codex' --trust-installation");
  expect(out.repair?.condition).toContain("不要递归");
  expect(out.explanation).toContain("已登录不等于");
});
it("never grants trust to world-writable paths or private registry metadata", () => {
  const row = state(); row.detail!.rule = "world_writable";
  expect(executableRecovery(row, undefined, 1002)).toMatchObject({ repair: { command: "chmod go-w -- '/home/chris/.local/bin'" } });
  expect(executableRecovery(row, undefined, 1002)?.trust).toBeUndefined();
  row.detail!.rule = "group_writable"; row.detail!.stage = "registry";
  expect(executableRecovery(row, undefined, 1002)?.trust).toBeUndefined();
});
it("does not suggest chmod of another owner's installation or invent a choice among candidates", () => {
  const row = state(); row.candidates.push({ entry: "/opt/other/codex", source: "standard", preferred: false });
  const out = executableRecovery(row, undefined, 7)!;
  expect(out.repair).toBeUndefined(); expect(out.trust).toBeUndefined();
  expect(out.steps.join(" ")).toContain("实际安装管理者");
});
it("quotes shell metacharacters and retains an explicitly bound interpreter", () => {
  const row = state(); row.detail!.path = "/home/chris/a '$(touch oops)'";
  const out = executableRecovery(row, { entry: "/home/chris/a 'x'", interpreter: "/home/chris/node 22" }, 1002)!;
  expect(out.repair?.command).toBe("chmod g-w -- '/home/chris/a '\\''$(touch oops)'\\''' ".trim());
  expect(out.trust?.command).toContain("--interpreter '/home/chris/node 22'");
});
it("keeps successful discovery and other diagnostics unchanged", () => {
  const row = state(); row.reason = "command_unavailable";
  expect(executableRecovery(row, undefined, 1002)).toBeUndefined();
});
