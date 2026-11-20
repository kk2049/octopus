/**
 * Pack-time inlining of PURE JavaScript dependencies into a declared App's
 * sandboxed backend (ADR 0007 principle 6 / primitive P6).
 *
 * ── What this changes, and what it deliberately does not ────────────────────
 *
 * The SES Compartment that runs `app/actions.ts` / `app/projection.ts` already
 * executes arbitrary publisher JavaScript with no ambient authority: `fetch`,
 * `process`, `require` and `node:*` are ABSENT, and the module `resolveHook`
 * refuses every specifier that is not a relative path inside the app directory
 * (`packages/engine/src/runtime/sandbox-child.mjs`). Inlining MORE pure
 * JavaScript into that same Compartment adds zero authority — but only if the
 * bundle step provably cannot smuggle in a Node builtin, a leftover external
 * reference, a dynamic `import()`, or top-level await. So every one of those is
 * a pack-time REFUSAL here, not a warning; the closed refusal list is
 * `BackendBundleRefusal` below.
 *
 * Runtime behavior is unchanged: the Compartment still forbids imports, the
 * lockdown and endowment table are untouched. The only thing that moved is
 * WHERE "no imports" is established — the packed asset may now be produced by
 * bundling a multi-file + node_modules source, and the produced asset is what
 * the existing digests cover.
 *
 * ── Digest coverage: the digested source IS the executed bytes ──────────────
 *
 * The bundled output is stored as the release's `app/actions.ts` /
 * `app/projection.ts` asset. From there the existing chain applies unmodified:
 * the registry's `packageDigest` covers the asset bytes, `materialiseBackendTree`
 * lays exactly those bytes on disk, `backendRelease()` computes
 * `backendCodeDigest` over exactly those files, and the sandbox child loads the
 * same files. There is no path where digested source ≠ executed bytes — the
 * final verification below even re-runs the runtime's own load transform
 * (`stripTypeScriptTypes`, then endo `ModuleSource`) on the exact bytes being
 * packed and asserts it is the identity plus a successful zero-import parse.
 *
 * ── Byte identity for existing apps ─────────────────────────────────────────
 *
 * An entry that is already inert under the runtime grammar — no static imports,
 * no re-exports, no dynamic `import()`, no `import.meta` — passes through
 * VERBATIM. Both in-tree app backends are in this class, so every existing
 * release packs byte-identically to before and no release shape changes.
 * Bundling happens only when the entry actually imports something.
 *
 * ── Where an app's dependencies live ────────────────────────────────────────
 *
 * Bare specifiers resolve with ordinary Node resolution starting at the app
 * directory: the package that OWNS the app dir declares its pure deps in its own
 * `package.json`, pnpm installs them, and `pnpm-lock.yaml` pins them — the same
 * lockfile whose hash the release descriptor already records in `buildInput`.
 * Relative imports from files inside the app directory must stay inside the app
 * directory (the same jail the runtime's `resolveWithin` enforces); a
 * dependency's own internal relative imports are its own business and are
 * inlined and digested like everything else.
 *
 * ── Tool choice (recorded in the delivery document) ──────────────────────────
 *
 * esbuild, via its async JS API. It is already in this tree (vite embeds it for
 * every View build; the `@esbuild/linux-x64` binary ships prebuilt, so
 * `allowBuilds: esbuild: false` does not affect it), and ADR 0007 P6 names it.
 * `buildSync` is deliberately NOT used: on this host its error path deadlocks,
 * and combining `metafile` with a failing build crashes the IPC channel — which
 * is why bundling is two passes: pass 1 without metafile surfaces every error
 * and warning catchably; pass 2 with metafile runs only after pass 1 was clean
 * and produces both the audit edges and the bytes that are actually packed.
 */

import * as path from "node:path";
import { readFileSync } from "node:fs";
import { builtinModules, stripTypeScriptTypes } from "node:module";
import { build, type BuildOptions, type Message, type Metafile } from "esbuild";
import { evadeCensorSync } from "@endo/evasive-transform";
import { ModuleSource } from "@endo/module-source";

/** The closed set of reasons a backend bundle is refused. */
export type BackendBundleRefusal =
  | "entry_outside_app"
  | "entry_unparseable"
  | "builtin_import"
  | "unresolved_import"
  | "dynamic_import"
  | "import_meta"
  | "top_level_await"
  | "bundler_warning"
  | "escapes_app_dir"
  | "external_remnant"
  | "output_not_plain_js"
  | "output_too_large"
  | "ses_censor_remnant"
  | "export_mismatch"
  | "bundle_failed";

/** A pack-time refusal. The `refusal` code is stable; the message is for a log. */
export class BackendBundleError extends Error {
  readonly refusal: BackendBundleRefusal;
  constructor(refusal: BackendBundleRefusal, message: string) {
    super(message);
    this.name = "BackendBundleError";
    this.refusal = refusal;
  }
}

export interface BackendBundleResult {
  /** The exact bytes to store as the release asset. */
  source: string;
  /** false = the entry was verbatim pass-through (zero-dep app, byte-identical). */
  bundled: boolean;
  /** Number of source modules inlined (1 for pass-through). */
  moduleCount: number;
  /** Sorted, de-duplicated bare npm specifiers that were inlined. */
  npmPackages: readonly string[];
}

/**
 * 1 MiB. A backend is a rule set plus a pure dependency or two; anything larger
 * is either an accidental dependency avalanche or an attempt to hide something
 * in volume, and both deserve a pack failure rather than a slow review.
 */
export const MAX_BACKEND_BUNDLE_BYTES = 1024 * 1024;

/** What the runtime's parser reports about one module source. */
interface ModuleFacts {
  imports: readonly string[];
  exports: readonly string[];
  reexports: readonly string[];
  needsImport: boolean;
  needsImportMeta: boolean;
}

/** The analysis fields endo's ModuleSource exposes but does not type. */
interface AnalyzedModuleSource {
  imports: readonly string[];
  exports: readonly string[];
  reexports: readonly string[];
  __needsImport__: boolean;
  __needsImportMeta__: boolean;
}

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

/**
 * Apply EXACTLY the runtime child's load transform: strip TypeScript types for
 * `.ts` names, then parse with endo's ModuleSource — the same grammar, the same
 * censorship (direct eval, HTML comments, …) the Compartment will apply.
 */
function moduleFacts(text: string, fileName: string): ModuleFacts {
  const js = /\.[cm]?ts$/.test(fileName) ? stripTypeScriptTypes(text, { mode: "strip" }) : text;
  const parsed = new ModuleSource(js, fileName) as unknown as AnalyzedModuleSource;
  return {
    imports: parsed.imports,
    exports: parsed.exports,
    reexports: parsed.reexports,
    needsImport: parsed.__needsImport__,
    needsImportMeta: parsed.__needsImportMeta__,
  };
}

/** An entry with none of these is inert: the runtime would never call a hook for it. */
function isInert(facts: ModuleFacts): boolean {
  return (
    facts.imports.length === 0
    && facts.reexports.length === 0
    && !facts.needsImport
    && !facts.needsImportMeta
  );
}

/** "@scope/name/deep/path" → "@scope/name"; "name/deep" → "name". */
function packageNameOf(bareSpecifier: string): string {
  const parts = bareSpecifier.split("/");
  return bareSpecifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Metafile paths are relative to the app dir; inside means no `../` escape. */
function insideAppDir(metafilePath: string): boolean {
  if (path.isAbsolute(metafilePath)) return false;
  const normalized = path.normalize(metafilePath);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function refuse(refusal: BackendBundleRefusal, message: string): never {
  throw new BackendBundleError(refusal, message);
}

/** Turn esbuild's pass-1 failure into the matching refusal. */
function classifyBuildFailure(entryName: string, messages: readonly Message[]): never {
  for (const message of messages) {
    const unresolved = /Could not resolve "([^"]+)"/.exec(message.text);
    if (unresolved) {
      const specifier = unresolved[1]!;
      if (isNodeBuiltin(specifier)) {
        refuse(
          "builtin_import",
          `${entryName}: 依赖链引用了 Node 内建模块 "${specifier}"。沙箱后端只接受纯 JS 依赖 — `
            + "没有文件系统、网络或进程；换一个不碰平台能力的实现",
        );
      }
      refuse(
        "unresolved_import",
        `${entryName}: 无法解析 "${specifier}"。裸导入必须能从 app 目录按 Node 规则解析到已安装的纯 JS 包`
          + "（声明在所属包的 package.json 里并已 pnpm install）",
      );
    }
    if (/[Tt]op-level await/.test(message.text)) {
      refuse(
        "top_level_await",
        `${entryName}: 依赖链包含顶层 await，SES 模块实例化是同步的，不支持它：${message.text}`,
      );
    }
  }
  const first = messages[0]?.text ?? "esbuild 未给出错误详情";
  refuse("bundle_failed", `${entryName}: 打包失败：${first}`);
}

/**
 * Check every resolved import edge the bundle actually took. This is where
 * dynamic import is caught (esbuild would otherwise INLINE a bundlable dynamic
 * import silently), where a builtin hidden behind an npm stub package of the
 * same name is refused, and where the app-dir jail for the app's own relative
 * imports — the same rule the runtime enforces — is applied.
 */
function checkImportEdges(entryName: string, metafile: Metafile): { npmPackages: string[] } {
  const npm = new Set<string>();
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    const importerInsideApp = insideAppDir(inputPath);
    for (const edge of input.imports) {
      if (edge.external) {
        refuse(
          "external_remnant",
          `${entryName}: ${inputPath} 的 "${edge.original ?? edge.path}" 保持 external，产物会残留运行时无法解析的引用`,
        );
      }
      if (edge.kind === "dynamic-import") {
        refuse(
          "dynamic_import",
          `${entryName}: ${inputPath} 使用了动态 import("${edge.original ?? edge.path}")。`
            + "声明式 App 的后端必须是静态模块图 — 动态加载在打包期无法审计，一律拒绝",
        );
      }
      if (edge.kind === "require-resolve") {
        refuse(
          "dynamic_import",
          `${entryName}: ${inputPath} 使用了 require.resolve("${edge.original ?? edge.path}")，沙箱里不存在模块路径`,
        );
      }
      const original = edge.original;
      if (original === undefined) continue;
      if (isNodeBuiltin(original)) {
        refuse(
          "builtin_import",
          `${entryName}: ${inputPath} 引用了 Node 内建模块 "${original}"`
            + "（即使 node_modules 里装了同名替身包也不放行）",
        );
      }
      if (original.startsWith("./") || original.startsWith("../")) {
        if (importerInsideApp && !insideAppDir(edge.path)) {
          refuse(
            "escapes_app_dir",
            `${entryName}: ${inputPath} 的相对导入 "${original}" 逃出了 app 目录。`
              + "app 自己的文件必须留在 app 目录内；目录外的代码请作为包依赖引入",
          );
        }
      } else if (path.isAbsolute(original)) {
        refuse(
          "escapes_app_dir",
          `${entryName}: ${inputPath} 使用了绝对路径导入 "${original}"`,
        );
      } else {
        npm.add(packageNameOf(original));
      }
    }
  }
  return { npmPackages: [...npm].sort() };
}

/**
 * Produce the release-asset bytes for one executable backend file.
 *
 * An inert entry (no imports of any kind) is returned VERBATIM — that is the
 * no-op path every pre-existing app takes, and it keeps their releases
 * byte-identical. An entry with imports is bundled into one self-contained
 * module and then re-verified under the runtime's own grammar.
 */
export async function bundleAppBackend(entryFile: string, appDir: string): Promise<BackendBundleResult> {
  const appRoot = path.resolve(appDir);
  const entryAbs = path.resolve(entryFile);
  const entryRel = path.relative(appRoot, entryAbs);
  if (entryRel.startsWith("..") || path.isAbsolute(entryRel)) {
    refuse("entry_outside_app", `后端入口 ${entryFile} 不在 app 目录 ${appDir} 内`);
  }
  const entryName = entryRel.split(path.sep).join("/");
  const originalText = readFileSync(entryAbs, "utf8");

  let entryFacts: ModuleFacts;
  try {
    entryFacts = moduleFacts(originalText, entryName);
  } catch (error) {
    // Today an unparseable entry packs fine and fails at activation; saying so
    // at pack time is the same refusal moved to where the author is looking.
    refuse(
      "entry_unparseable",
      `${entryName} 无法按运行时文法解析（先 stripTypeScriptTypes 再 ModuleSource）：`
        + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isInert(entryFacts)) {
    return { source: originalText, bundled: false, moduleCount: 1, npmPackages: [] };
  }

  const options: BuildOptions = {
    entryPoints: [entryAbs],
    absWorkingDir: appRoot,
    bundle: true,
    write: false,
    format: "esm",
    // `neutral`: no implicit externals, no Node builtin passthrough, no
    // platform globals — anything unresolvable is a build ERROR, not an import
    // that survives into the output.
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    // The SES module instance executes synchronously; make esbuild refuse TLA
    // anywhere in the graph instead of emitting it.
    supported: { "top-level-await": false },
    logLevel: "silent",
    outfile: "backend-bundle.js",
  };

  // Pass 1, no metafile: every resolve error, TLA, and warning surfaces as a
  // catchable failure. (`metafile` on a FAILING build crashes esbuild's IPC.)
  let firstPassWarnings: readonly Message[];
  try {
    const first = await build(options);
    firstPassWarnings = first.warnings;
  } catch (error) {
    const messages = (error as { errors?: Message[] }).errors;
    if (Array.isArray(messages) && messages.length > 0) classifyBuildFailure(entryName, messages);
    throw error;
  }
  if (firstPassWarnings.length > 0) {
    // A warning here is esbuild saying "I emitted something that will not do
    // what the source said" — e.g. a non-literal require left as a shim. For a
    // security-sensitive bundle that is a refusal, not advice.
    refuse(
      "bundler_warning",
      `${entryName}: 打包器警告一律按失败处理：${firstPassWarnings.map((w) => w.text).join(" | ")}`,
    );
  }

  // Pass 2, metafile on: same deterministic inputs, now with the audit edges.
  const second = await build({ ...options, metafile: true });
  const metafile = second.metafile!;
  const outputs = second.outputFiles ?? [];
  if (outputs.length !== 1) {
    refuse("bundle_failed", `${entryName}: 期望恰好一个产物文件，得到 ${outputs.length} 个`);
  }
  const { npmPackages } = checkImportEdges(entryName, metafile);
  const moduleCount = Object.keys(metafile.inputs).length;

  const banner =
    `// 打包期内联产物（backend-bundle）：入口 ${entryName}，共 ${moduleCount} 个模块`
    + `${npmPackages.length > 0 ? `，npm 依赖：${npmPackages.join(", ")}` : ""}。运行时零 import。\n`;
  // SES's censor is TEXTUAL: a "-->" inside a string literal rejects the whole
  // module at Compartment import (the first real case: chess.js ships a parser
  // error template containing " --> "). esbuild cannot know that, and neither
  // pass above sees it. @endo/evasive-transform is endo's own answer — an
  // AST-aware rewrite ("a --> b" → "a --"+"> b", `i-->0` → `(0,i--)>0`) that
  // preserves semantics. Every later gate below runs on the EVADED bytes, so
  // what is digested, stripped, parsed and export-checked is what ships.
  let evadedText: string;
  try {
    evadedText = evadeCensorSync(outputs[0]!.text, { sourceType: "module" }).code;
  } catch (error) {
    refuse(
      "ses_censor_remnant",
      `${entryName}: 产物无法通过 SES 审查规避改写：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const source = banner + evadedText!;
  if (/-->|<!--/.test(source)) {
    refuse(
      "ses_censor_remnant",
      `${entryName}: 产物在规避改写后仍含 SES 会拒绝的 HTML 注释序列（--> 或 <!--）`,
    );
  }

  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength > MAX_BACKEND_BUNDLE_BYTES) {
    refuse(
      "output_too_large",
      `${entryName}: 产物 ${byteLength} 字节，超过 ${MAX_BACKEND_BUNDLE_BYTES} 字节上限。`
        + "后端应当是规则集加一两个纯依赖；先给依赖瘦身",
    );
  }

  // The asset keeps its `.ts` name, so the runtime will run stripTypeScriptTypes
  // over it before parsing. Assert that transform is the IDENTITY on our plain-JS
  // output: what the digest covers is exactly what the Compartment executes.
  let strippedBack: string;
  try {
    strippedBack = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (error) {
    refuse(
      "output_not_plain_js",
      `${entryName}: 产物无法通过运行时的类型剥离：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (strippedBack !== source) {
    refuse("output_not_plain_js", `${entryName}: 产物经运行时类型剥离后字节发生变化，拒绝发布语义不确定的字节`);
  }

  // Final gate, on the EXACT bytes being packed, under the runtime's grammar:
  // zero imports of any kind may remain, and the entry's export surface must
  // have survived bundling unchanged.
  let outputFacts: ModuleFacts;
  try {
    outputFacts = moduleFacts(source, entryName);
  } catch (error) {
    refuse(
      "output_not_plain_js",
      `${entryName}: 产物无法按运行时文法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (outputFacts.imports.length > 0 || outputFacts.reexports.length > 0) {
    refuse(
      "external_remnant",
      `${entryName}: 产物仍含 import 引用（${[...outputFacts.imports, ...outputFacts.reexports].join(", ")}）`,
    );
  }
  if (outputFacts.needsImport) {
    refuse("dynamic_import", `${entryName}: 产物仍含动态 import()`);
  }
  if (outputFacts.needsImportMeta) {
    refuse(
      "import_meta",
      `${entryName}: 产物引用 import.meta，Compartment 里它不是有意义的对象；纯函数后端不该询问自己的宿主`,
    );
  }
  const wantExports = [...entryFacts.exports].sort().join(",");
  const gotExports = [...outputFacts.exports].sort().join(",");
  if (wantExports !== gotExports) {
    refuse(
      "export_mismatch",
      `${entryName}: 打包改变了导出面 — 源 [${wantExports}] vs 产物 [${gotExports}]`,
    );
  }

  return { source, bundled: true, moduleCount, npmPackages };
}
