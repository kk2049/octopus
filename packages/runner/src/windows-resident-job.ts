/**
 * Task Scheduler may terminate only its root action, leaving Node alive.
 * Place the GUI host itself in an OS Job before spawning children: Windows
 * then owns descendant teardown even if the action crashes or is force-killed.
 * No breakaway, named global resource, privilege elevation or extra dependency.
 * See https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
 */
export const WINDOWS_RESIDENT_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OctopusResidentJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  // Keep this non-inheritable handle open for the action's entire lifetime.
  private static IntPtr job;
  public static void Attach() {
    if (job != IntPtr.Zero) return;
    IntPtr candidate = CreateJobObject(IntPtr.Zero, null);
    if (candidate == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(candidate, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))
      || !AssignProcessToJobObject(candidate, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(candidate);
      throw new Win32Exception(error);
    }
    job = candidate;
  }
}
`;
