import { createHash } from "node:crypto";
import { WINDOWS_RESIDENT_JOB_SOURCE } from "./windows-resident-job.js";

/** A GUI task action creates no console and owns the entire resident Job. */
export const WINDOWS_RESIDENT_HOST_SOURCE = WINDOWS_RESIDENT_JOB_SOURCE + String.raw`
public static class OctopusResidentHost {
  [System.STAThread]
  public static int Main(string[] args) {
    if (args.Length != 1) return 2;
    string root = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(args[0]));
    try {
      OctopusResidentJob.Attach();
      var start = new System.Diagnostics.ProcessStartInfo();
      start.FileName = System.IO.Path.Combine(System.Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
      start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + args[0] + "\" run";
      start.WorkingDirectory = root;
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.RedirectStandardOutput = true;
      start.RedirectStandardError = true;
      using (var child = new System.Diagnostics.Process()) {
        child.StartInfo = start;
        child.OutputDataReceived += (sender, e) => { };
        child.ErrorDataReceived += (sender, e) => { };
        child.Start();
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
        child.WaitForExit();
        return child.ExitCode;
      }
    } catch (System.Exception) {
      return 1;
    }
  }
}
`;

export const WINDOWS_RESIDENT_HOST_NAME =
  `octopus-runner-host-${createHash("sha256").update(WINDOWS_RESIDENT_HOST_SOURCE).digest("hex").slice(0, 16)}.exe`;
