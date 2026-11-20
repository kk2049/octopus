import { spawn } from "node:child_process";

/**
 * Minimal read-only Git access for graph builds. Kept local so the knowledge
 * module does not depend on devpipe (which depends on it).
 */
export interface GitRunner {
  (args: string[]): Promise<string>;
}

export function gitRunner(repoDir: string, timeoutMs = 60_000): GitRunner {
  // Whole output, no maxBuffer: a history query over a growing repository
  // must not fail at an arbitrary size. Collected here rather than through
  // devpipe's runner because devpipe depends on this module.
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: repoDir, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdin.end();
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => { err.push(chunk); });
      child.on("error", (error) => { clearTimeout(timer); reject(new Error(`git ${args.slice(0, 3).join(" ")}: ${error.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = Buffer.concat(err).toString("utf8").trim().slice(-400) || `exit ${code}`;
          reject(new Error(`git ${args.slice(0, 3).join(" ")}: ${detail}`));
          return;
        }
        resolve(Buffer.concat(out).toString("utf8").replace(/\n$/, ""));
      });
    });
}

export async function resolveSha(git: GitRunner, ref: string): Promise<string> {
  return (await git(["rev-parse", `${ref}^{commit}`])).trim();
}

/** Every file at a commit (`git ls-tree -r`); callers filter with `matchGlobs`. */
export async function listTree(git: GitRunner, sha: string): Promise<string[]> {
  const out = await git(["ls-tree", "-r", "--name-only", "-z", sha]);
  return out.split("\0").filter(Boolean);
}

/** Tracked + untracked (not ignored) files of the working tree. */
export async function listWorktree(git: GitRunner): Promise<string[]> {
  const out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return [...new Set(out.split("\0").filter(Boolean))];
}

/**
 * Minimal glob → RegExp: `**` crosses directories, `*` and `?` stay within one
 * segment, `{a,b}` alternates. Enough for the patterns the sources use; the
 * git pathspec semantics differ between `ls-tree` and `ls-files`, so both
 * listing modes share this one matcher.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const slash = glob[index + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else if (char === "{") {
      const close = glob.indexOf("}", index);
      if (close === -1) out += "\\{";
      else {
        out += `(?:${glob.slice(index + 1, close).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
        index = close;
      }
    } else out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

export function matchGlobs(files: readonly string[], patterns: readonly string[]): string[] {
  if (!patterns.length) return [...files];
  const regexps = patterns.map(globToRegExp);
  return files.filter((file) => regexps.some((regexp) => regexp.test(file)));
}

export async function readAt(git: GitRunner, sha: string, path: string): Promise<string> {
  return git(["show", `${sha}:${path}`]);
}

export async function introducedBy(git: GitRunner, sha: string, path: string): Promise<string | null> {
  const out = await git(["log", "--diff-filter=A", "-1", "--format=%H", sha, "--", path]);
  return out.trim() || null;
}

export async function changedBetween(git: GitRunner, base: string, head: string): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--no-renames", `${base}...${head}`]);
  return out.split("\n").filter(Boolean);
}

export async function commitDate(git: GitRunner, sha: string): Promise<string | null> {
  const out = await git(["show", "-s", "--format=%cI", sha]);
  return out.trim() || null;
}
