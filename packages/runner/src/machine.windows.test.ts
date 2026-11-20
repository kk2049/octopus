import { describe, expect, it } from "vitest";
import { machineExec } from "./machine.js";

describe.skipIf(process.platform !== "win32" || !process.env.RUNNER_TEST_PYTHON)("Windows remote shell visibility", () => {
  it("runs the configured Python without a visible console and returns output through RPC", async () => {
    // Use a real interpreter, never a Windows Store installation alias.
    const script = "import ctypes,json; k=ctypes.windll.kernel32; u=ctypes.windll.user32; k.GetConsoleWindow.restype=ctypes.c_void_p; u.IsWindowVisible.argtypes=[ctypes.c_void_p]; print(json.dumps({'visible':bool(u.IsWindowVisible(k.GetConsoleWindow())),'result':'python-rpc-output'}))";
    const interpreter = process.env.RUNNER_TEST_PYTHON ?? "python";
    const result = await machineExec({ command: `"${interpreter}" -c "${script}"` });
    expect(result.ok, result.stderr).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ visible: false, result: "python-rpc-output" });
  });
});
