/**
 * Reading a built Agent View back, and refusing every way it could be wrong.
 *
 * ── The failure this file exists to make impossible ─────────────────────────
 *
 * The View's bytes are its identity: they decide `viewAssetDigest`, they feed
 * `packageDigest`, and the first twenty hex characters of that digest are the
 * hostname the frame is served from. Before React the bytes were module
 * constants, so "the code and its name agree" was true by construction. Now they
 * are build output, and build output has two new ways to lie:
 *
 *   · **absent** — nobody ran the build in this tree;
 *   · **stale** — somebody edited a component and did not rebuild, so the
 *     process would happily serve last week's View under a hostname derived
 *     from last week's bytes, which is internally consistent and completely
 *     wrong about what is running.
 *
 * The second one is the dangerous one, because everything downstream still
 * agrees with itself. So the manifest records a digest of every INPUT file
 * alongside a digest of every OUTPUT byte, and this loader recomputes both.
 * Neither answer is "serve what we have": a mismatch throws, naming the command
 * that fixes it.
 *
 * The digest function is shared with the build plugin — literally the same
 * function, not the same algorithm written twice — because two implementations
 * of "which files are inputs" would drift and the drift would show up as a
 * build that is permanently "stale".
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { AGENT_VIEW_THEME_SOURCE_BYTES } from "@claude-bot/agent-view-build/theme-tokens";

/** Written into the output directory next to the two assets. */
export const AGENT_VIEW_MANIFEST_FILE = "build-manifest.json";

/**
 * Who produced a build, recorded in the manifest and quoted in release recipes.
 *
 * It lives in this module rather than next to the Vite config so a consumer can
 * name the builder without importing Vite: the bot process publishes releases
 * and never builds them, and pulling a bundler into a server runtime to read one
 * string would be a dependency nobody chose.
 */
export const AGENT_VIEW_BUILDER = "octopus:agent-view-vite-1";
export const APP_MODULE_BUILDER = "octopus:app-module-vite-2";

export interface AgentViewOutput {
  name: string;
  sha256: string;
  bytes: number;
}

export interface AgentViewBuildManifest {
  schema: 1;
  builder: string;
  /** Digest over every input file the build read. */
  sourceDigest: string;
  outputs: AgentViewOutput[];
}

export interface AgentViewSourceInput {
  /**
   * Directories walked recursively. `node_modules`, build output and dotfiles
   * are skipped; everything else counts, because "which extensions matter" is a
   * guess and a wrong guess makes a real edit invisible.
   */
  roots: readonly string[];
  /** Individual files — manifests, configs — that also decide the output. */
  files?: readonly string[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git", ".vite"]);

function walk(root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (cause) {
    throw new Error(`Agent View 声明的源码目录不可读：${root}`, { cause });
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    } else if (entry.isSymbolicLink()) {
      // Following a mutable link would make the digest depend on bytes outside
      // the declared source tree; silently skipping it would omit a Vite input.
      throw new Error(`Agent View 源码树不接受符号链接：${full}`);
    }
  }
}

/**
 * A digest over the exact bytes of every input, keyed by path relative to the
 * root it was found under.
 *
 * Paths are relative and normalised to `/` so the digest is a property of the
 * source tree rather than of the checkout directory or the operating system —
 * two machines building the same commit must agree, or "stale" would fire on
 * every deploy.
 */
export function agentViewSourceDigest(input: AgentViewSourceInput): string {
  const named: Array<[string, string]> = [];
  for (const [rootIndex, root] of input.roots.entries()) {
    const absolute = path.resolve(root);
    let info;
    try {
      info = lstatSync(absolute);
    } catch (cause) {
      throw new Error(`Agent View 声明的源码目录不存在：${absolute}`, { cause });
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Agent View 声明的源码目录不是普通目录：${absolute}`);
    }
    const files: string[] = [];
    walk(absolute, files);
    for (const file of files) {
      named.push([
        `root:${rootIndex}/${path.relative(absolute, file).split(path.sep).join("/")}`,
        file,
      ]);
    }
  }
  for (const [fileIndex, file] of (input.files ?? []).entries()) {
    const absolute = path.resolve(file);
    let info;
    try {
      info = lstatSync(absolute);
    } catch (cause) {
      throw new Error(`Agent View 声明的构建输入不存在：${absolute}`, { cause });
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Agent View 声明的构建输入不是普通文件：${absolute}`);
    }
    named.push([`file:${fileIndex}/${path.basename(absolute)}`, absolute]);
  }
  named.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = createHash("sha256");
  hash.update("agent-view-source\0", "utf8");
  hash.update(`theme-registry\0${Buffer.byteLength(AGENT_VIEW_THEME_SOURCE_BYTES)}\0`, "utf8");
  hash.update(AGENT_VIEW_THEME_SOURCE_BYTES, "utf8");
  for (const [name, file] of named) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (cause) {
      throw new Error(`Agent View 构建输入不可读：${file}`, { cause });
    }
    hash.update(`${name}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export interface LoadedAgentViewRelease {
  manifest: AgentViewBuildManifest;
  /** Output file name → UTF-8 source, in manifest order. */
  assets: Array<{ name: string; source: string }>;
}

export interface LoadAgentViewReleaseOptions {
  /** Directory the build wrote to. */
  distDir: string;
  /** The same inputs the build hashed. */
  source: AgentViewSourceInput;
  /** Printed verbatim in every refusal, e.g. `pnpm --filter … build`. */
  buildCommand: string;
  /** Exact output inventory this publisher knows how to embed, in order. */
  expectedOutputs: readonly string[];
  /** ESM packages include a manifest-declared set of worker/chunk assets. */
  allowModuleAssets?: boolean;
}

/**
 * Load the built View, or throw a message that says exactly what to do.
 *
 * Four refusals, in the order a person hits them:
 *
 *   1. no manifest — the build never ran in this tree;
 *   2. an output missing, or its bytes not matching the manifest — a partial or
 *      interrupted write, which would otherwise be published as a truncated
 *      document;
 *   3. inputs no longer hashing to what the build recorded — somebody edited a
 *      component and did not rebuild;
 *   4. a manifest this loader does not understand — a schema or builder from a
 *      future release, which must not be interpreted optimistically.
 */
export function loadAgentViewRelease(options: LoadAgentViewReleaseOptions): LoadedAgentViewRelease {
  const distDir = path.resolve(options.distDir);
  const manifestPath = path.join(distDir, AGENT_VIEW_MANIFEST_FILE);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(
      `Agent View 产物缺失：找不到 ${manifestPath}。请先构建：${options.buildCommand}`,
    );
  }
  let manifest: AgentViewBuildManifest;
  try {
    manifest = JSON.parse(raw) as AgentViewBuildManifest;
  } catch {
    throw new Error(`Agent View 构建清单无法解析：${manifestPath}。请重新构建：${options.buildCommand}`);
  }
  if (manifest?.schema !== 1 || !Array.isArray(manifest.outputs) || !manifest.outputs.length) {
    throw new Error(
      `Agent View 构建清单不是本进程认识的格式（schema=${String(manifest?.schema)}）。请重新构建：${options.buildCommand}`,
    );
  }
  const expectedBuilder = options.allowModuleAssets ? APP_MODULE_BUILDER : AGENT_VIEW_BUILDER;
  if (manifest.builder !== expectedBuilder) {
    throw new Error(
      `Agent View 构建器不受信任（builder=${String(manifest.builder)}，expected=${expectedBuilder}）。`
        + `请重新构建：${options.buildCommand}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceDigest)) {
    throw new Error(`Agent View 构建清单的 source digest 无效。请重新构建：${options.buildCommand}`);
  }
  const outputNames: string[] = [];
  for (const rawOutput of manifest.outputs as unknown[]) {
    const output = rawOutput as Partial<AgentViewOutput> | null;
    if (
      !output
      || typeof output.name !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(output.name)
      || typeof output.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(output.sha256)
      || typeof output.bytes !== "number"
      || !Number.isSafeInteger(output.bytes)
      || output.bytes < 0
    ) {
      throw new Error(`Agent View 构建清单含无效产物记录。请重新构建：${options.buildCommand}`);
    }
    outputNames.push(output.name);
  }
  if (new Set(outputNames).size !== outputNames.length) {
    throw new Error(`Agent View 构建清单重复声明产物。请重新构建：${options.buildCommand}`);
  }
  if (
    options.allowModuleAssets
      ? !options.expectedOutputs.every((name) => outputNames.includes(name))
        || !outputNames.includes("agent-view.entry.json")
      : outputNames.length !== options.expectedOutputs.length
        || outputNames.some((name, index) => name !== options.expectedOutputs[index])
  ) {
    throw new Error(
      `Agent View 构建产物集合不符合发布契约：actual=${outputNames.join(",")} `
        + `expected=${options.expectedOutputs.join(",")}。请重新构建：${options.buildCommand}`,
    );
  }

  const assets = manifest.outputs.map((output) => {
    const file = path.join(distDir, output.name);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
      // A directory reads as an error on most platforms, but be explicit: a
      // zero-length answer must never be mistaken for an empty asset.
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Agent View 产物缺失：${file}（清单里有，磁盘上没有）。请重新构建：${options.buildCommand}`);
    }
    if (bytes.byteLength !== output.bytes || sha256Hex(bytes) !== output.sha256) {
      throw new Error(
        `Agent View 产物与构建清单不一致：${output.name}。这通常是一次被打断的构建；`
          + `发布这样的字节会让 digest 与实际内容不符。请重新构建：${options.buildCommand}`,
      );
    }
    return { name: output.name, source: bytes.toString("utf8") };
  });

  const actual = agentViewSourceDigest(options.source);
  if (actual !== manifest.sourceDigest) {
    throw new Error(
      "Agent View 源码在上次构建之后变过（source digest 不一致）。继续运行会用旧字节发布一个由旧字节算出的 "
        + `digest 主机名——自洽但不正确。请重新构建：${options.buildCommand}`,
    );
  }

  return { manifest, assets };
}
