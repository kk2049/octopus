export interface FakeExecutables {
  /** Private root holding `bin`, `runtime` and (by default) `home`. */
  dir: string;
  bin: string;
  home: string;
  /** PATH reaching only the fakes, this runner's `node`, and checked system directories. */
  path: string;
  /** `process.env` copy with that PATH and HOME. */
  env: NodeJS.ProcessEnv;
  /** Add or replace one fake executable (mode 0755) and return its path. */
  write(name: string, body: string): string;
  /** Pin `process.env.PATH`/`HOME`; returns the restore function (idempotent). */
  apply(): () => void;
  /** Restore any pinned environment and remove `dir`. */
  cleanup(): void;
}

export interface FakeExecutablesOptions {
  /** Use this existing directory as HOME instead of an empty private one. */
  home?: string;
  /** Extra directories searched after `bin` (for other fake tool directories). */
  extraPath?: string[];
  /** System directories appended to PATH; each is checked for real agent CLIs. Default /usr/bin, /bin. */
  systemPath?: string[];
  prefix?: string;
}

/** A temporary base directory whose files can be executed; throws when none can be proven. */
export function execTempDir(): string;
/** Point TMPDIR (inherited by child processes) at an exec-capable directory. */
export function ensureExecTmpdir(): string;
/** Fake executables in a proven exec-capable directory with an environment that reaches no real agent CLI. */
export function fakeExecutables(files?: Record<string, string>, options?: FakeExecutablesOptions): FakeExecutables;
