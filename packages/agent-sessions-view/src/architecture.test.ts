/**
 * The dependency boundary, enforced by reading this package's own source.
 *
 * A boundary that only exists in a review comment is not a boundary. Three
 * things must stay true here, and each one is a rule somebody could break with a
 * single convenient import:
 *
 *  1. **No App.** Importing `@claude-bot/session-plus-view` would make these
 *     "reusable" modules depend on the one product that uses them.
 *  2. **No transport.** `SESSION_PLUS_PROTOCOL`, `VIEW_HELLO`, `MessagePort`,
 *     `postMessage`, `fetch` — a module has a PORT. What is on the other end of
 *     it is the App's business, and a module that knew would be a module that
 *     could be told an identity.
 *  3. **No SDK root entry.** `@claude-bot/agent-view-react` re-exports the
 *     client and the wire constants; `/ui` and `/workspace` do not. Depending on
 *     the narrow entries is what makes rule 2 a type error rather than a habit.
 *  4. **No action/param/operation vocabulary.** `SESSION_ACTIONS`,
 *     `SESSION_PARAMS`, `SESSION_OPERATIONS` and `ALL_SOURCES` are what an App's
 *     adapter spends to satisfy the port — the wire spelling of a proposal and
 *     the Gate token it costs. A module that named one would be choosing what to
 *     ask a Host for, which is the App's decision and the App's audit record.
 *     `AGENT_SESSIONS_CONTRACT` is the exception and stays allowed: a manifest
 *     has to declare WHICH port the module needs.
 *
 * The harness is held to the same rules: it is a second consumer, and a second
 * consumer that cheated would prove nothing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This suite runs in the jsdom project, where `import.meta.url` is not a file
 * URL, so the tree is located from the working directory instead — which is the
 * repository root under `npx vitest run` and this package under a filtered run.
 */
const SRC = [
  path.resolve(process.cwd(), "packages/agent-sessions-view/src"),
  path.resolve(process.cwd(), "src"),
].find((candidate) => existsSync(candidate))!;

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (statSync(full).isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

function rawPixelValues(css: string): string[] {
  // Explanatory comments do not set geometry (e.g. the launch card's 44px icon).
  const styles = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...styles.matchAll(/-?\d+(?:\.\d+)?px\b/g)].map((match) => match[0]);
}

describe("agent-sessions-view dependency boundary", () => {
  const files = sources();

  it("finds the modules it is supposed to be checking", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("opts into shared chat CSS only at the bundle entry", () => {
    const entry = readFileSync(path.join(SRC, "index.ts"), "utf8");
    const componentSubpath = readFileSync(path.join(SRC, "transcript-ui.ts"), "utf8");
    expect(entry).toMatch(
      /import\s+["']@claude-bot\/chat-ui-commons\/transcript-ui\.css["']/,
    );
    expect(componentSubpath).not.toMatch(/(?:^|\n)\s*import\s+["'][^"']+\.css["']/);
  });

  it("imports no App and no Bot", () => {
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        expect(specifier, `${path.relative(SRC, file)} imports ${specifier}`).not.toMatch(
          /session-plus|@claude-bot\/bot|dashboard-web|web-trust/,
        );
      }
    }
  });

  it("depends only on the SDK's narrow entries, never its root", () => {
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith("@claude-bot/agent-view-react")) continue;
        expect(specifier, `${path.relative(SRC, file)} imports the SDK root`).toMatch(
          /^@claude-bot\/agent-view-react\/(ui|workspace)$/,
        );
      }
    }
  });

  it("names no wire constant and opens no channel of its own", () => {
    const forbidden = [
      /SESSION_PLUS_PROTOCOL/,
      /VIEW_HELLO/,
      /\bMessagePort\b/,
      /\bMessageChannel\b/,
      /\bpostMessage\s*\(/,
      /\bnew\s+EventSource\b/,
      /\bnew\s+WebSocket\b/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bFRONTIER_LOOKBACK\b/,
      /\bclientFrontier\b/,
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("names no action, param or operation vocabulary — that is an App adapter's", () => {
    // Word-bounded, because the module ids legitimately share a prefix:
    // `SESSION_OPERATIONS_MANIFEST` is this package's own status-strip module,
    // while `SESSION_OPERATIONS` is the Gate token table an adapter spends.
    const forbidden = [
      /\bSESSION_ACTIONS\b/,
      /\bSESSION_PARAMS\b/,
      /\bSESSION_OPERATIONS\b/,
      /\bALL_SOURCES\b/,
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
      // A module must still be able to say which port it needs, so the check has
      // to be able to tell those two things apart.
      if (path.basename(file) === "manifests.ts") {
        expect(source).toMatch(/\bAGENT_SESSIONS_CONTRACT\b/);
      }
    }
  });

  it("keeps the shared transcript faces SDK-free, transitively", () => {
    // `./transcript` and `./transcript-ui` are imported by the TRUSTED
    // Dashboard, which must never pull the Agent View SDK into its bundle —
    // the SDK belongs to the untrusted origin. One convenient import anywhere
    // in these faces' closure would silently merge the two bundles, so the
    // whole closure is walked, not just the entry files.
    const resolveLocal = (fromDir: string, specifier: string): string | null => {
      const base = path.resolve(fromDir, specifier);
      for (const candidate of [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        `${base}.ts`,
        `${base}.tsx`,
      ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
      return null;
    };
    const entries = [path.join(SRC, "transcript-ui.ts"), path.join(SRC, "lib", "transcript.ts")];
    for (const entry of entries) {
      expect(existsSync(entry), `${entry} is a package export and must exist`).toBe(true);
    }
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        expect(specifier, `${path.relative(SRC, file)} imports ${specifier}`).not.toMatch(
          /agent-view-react/,
        );
        if (specifier.startsWith(".")) {
          const resolved = resolveLocal(path.dirname(file), specifier);
          expect(resolved, `${path.relative(SRC, file)} imports unresolvable ${specifier}`).not.toBeNull();
          queue.push(resolved!);
        }
      }
    }
    // The closure must actually cover the chat surface, or this test is
    // checking two files and calling it a boundary.
    expect(seen.size).toBeGreaterThan(3);
  });

  it("has no way to be told an identity", () => {
    // The port carries none, so a module could only invent one. Naming any of
    // these would be the first visible step of doing exactly that.
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [/useIdentity/, /useOwner/, /useCapability/, /instanceHandle/, /csrf/i]) {
        expect(pattern.test(source), `${path.relative(SRC, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps the synthetic directory row left-aligned and DeepSeek chat full-width", () => {
    const css = readFileSync(path.join(SRC, "sessions.css"), "utf8");
    const directory = css.match(/\.home-directory \.wsdir\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(directory).toMatch(/justify-content:\s*flex-start/);
    expect(directory).toMatch(/width:\s*100%/);
    expect(directory).toMatch(/text-align:\s*start/);

    const composer = css.match(/html\[data-av-theme="deepseek"\] \.composer\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(composer).toMatch(/align-self:\s*stretch/);
    expect(composer).toMatch(/width:\s*100%/);
    expect(composer).not.toMatch(/780px/);

    const optionsCard = css.match(/\.composer-options-card\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(optionsCard).toMatch(/position:\s*absolute/);

    const desktopEntry = css.match(/\.composer-entry\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(desktopEntry).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto auto auto/);
    expect(desktopEntry).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\) auto/);
    const desktopInput = css.match(/\.composer-input-shell\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(desktopInput).toMatch(/grid-column:\s*1 \/ -1/);
    const desktopOptions = css.match(/\.composer-entry > \.composer-options\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(desktopOptions).toMatch(/grid-row:\s*2/);
    const desktopDeepSeekInput = css.match(
      /html\[data-av-theme="deepseek"\] \.composer:not\(\.composer-compact\) \.av-textarea\.ant-input\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    expect(desktopDeepSeekInput).toMatch(/padding-right:\s*var\(--av-s2\)/);

    const compact = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(compact).toMatch(/\.windowbar[\s\S]*display:\s*none/);
    expect(compact).toMatch(
      /\.composer-entry[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--av-g56\)/,
    );
    expect(compact).toMatch(/\.composer-options-card[\s\S]*width:\s*min\(var\(--av-g340\)/);
    expect(compact).toMatch(/\.av-textarea\.ant-input[\s\S]*font:\s*var\(--av-font-control\)/);
  });

  it("gives the shared run-config bar its own composer row in every theme (ticket #767)", () => {
    // Dock groups are often narrower than the viewport; sharing the button row
    // squeezed the pickers to a few characters. The bar spans the composer and
    // the buttons move one row down only when a bar is present.
    const css = readFileSync(path.join(SRC, "sessions.css"), "utf8");
    const bar = css.match(/\.composer-entry > \.run-config-bar\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(bar).toMatch(/grid-column:\s*1 \/ -1/);
    expect(bar).toMatch(/grid-row:\s*2/);
    const actions = css.match(
      /\.composer-entry-configured > :is\(\.composer-options, \.chat-upload-button, \.primary\)\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    expect(actions).toMatch(/grid-row:\s*3/);
    // Classic is the ABSENCE of data-av-theme, so a theme-gated reset would
    // leave a boxed text field inside the pill in the default appearance.
    expect(css).not.toMatch(/html\[data-av-theme\][^{]*\.run-config/);
  });

  it("keeps the search row one line tall (ticket #181)", () => {
    // The box is `width: 100%`, so the button is the flex item that gives. Left
    // to shrink, a two-character label wraps to one glyph per line and the row
    // becomes the tallest thing above the tree — worst on the phone layer,
    // where every control already carries the shared touch-target height.
    const css = readFileSync(path.join(SRC, "sessions.css"), "utf8");
    const button = css.match(/\.tools > \.av-button\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(button).toMatch(/flex:\s*none/);
    expect(button).toMatch(/white-space:\s*nowrap/);
  });

  it("keeps the phone directory session marker within the navigator row", () => {
    const css = readFileSync(path.join(SRC, "sessions.css"), "utf8");
    const compact = css.slice(css.indexOf("@media (max-width: 720px)"));
    const marker = compact.match(/\.wsrow \.directory-sessions-trigger\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(marker).toMatch(/height:\s*var\(--av-control-h-compact\)/);
    expect(marker).toMatch(/min-height:\s*var\(--av-control-h-compact\)/);
    expect(marker).toMatch(/margin-inline-start:\s*var\(--av-s1\)/);
    expect(marker).toMatch(/padding-inline:\s*var\(--av-s1\)/);
    expect(marker).toMatch(/gap:\s*var\(--av-g3\)/);
  });

  it("lays the navigator out as an activity bar beside one scrollable view", () => {
    const css = readFileSync(path.join(SRC, "sessions.css"), "utf8");
    const navigator = css.match(/\.navigator\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(navigator).toMatch(/grid-template-columns:\s*var\(--av-touch-target\) minmax\(0, 1fr\)/);
    expect(navigator).toMatch(/min-height:\s*0/);
    const narrow = css.match(/\.navigator\.narrow\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(narrow).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\)/);
    // Hidden views stay mounted; only `hidden` removes them from layout.
    expect(css).toMatch(/\.navigator-view\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
    const scroll = css.match(/\.nav-scroll\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(scroll).toMatch(/flex:\s*1 1 0/);
    expect(scroll).toMatch(/overflow:\s*auto/);
    const legacyList = css.match(/#list\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(legacyList).toMatch(/flex:\s*1 1 0/);
    // The row menu overlays the title end instead of reserving its width, and
    // stays reachable on touch screens without hover.
    expect(css.match(/\.sess-menu\s*\{([^}]*)\}/s)?.[1] ?? "").toMatch(/position:\s*absolute/);
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.sess-menu\s*\{\s*opacity:\s*1;/);
  });

  it("ignores pixel examples in CSS comments while still detecting hard-coded geometry", () => {
    const css = `/* The icon has a 44px box.
      Keep its card inside the shell. */
      .card { width: var(--av-g340); /* formerly 340px */ }
      @media (max-width: 720px) { .card { margin: 0; } }`;
    expect(rawPixelValues(css)).toEqual(["720px"]);
    expect(rawPixelValues(`${css}\n.card { min-height: 44px; margin-left: /* offset */ -1.5px; }`))
      .toEqual(["720px", "44px", "-1.5px"]);
  });

  it("keeps module geometry behind Agent View tokens", () => {
    const css = readFileSync(path.join(SRC, "sessions.css"), "utf8");
    // Custom properties cannot participate in media-query conditions, so the
    // responsive breakpoint is the sole deliberate literal left in the module.
    expect(rawPixelValues(css)).toEqual(["720px"]);
    expect(css).toContain("var(--av-control-h-md)");
    expect(css).toContain("var(--av-font-label)");
    expect(css).toContain("var(--av-weight-control)");
  });
});
