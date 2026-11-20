import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Edit the one conventional Dashboard block, refusing custom routing to review. */
export function configureStartup(source, site, snippet, assets, upstream) {
  if (!/^[a-z0-9.-]+$/.test(site) || !/^127\.0\.0\.1:\d+$/.test(upstream)
    || ![snippet, assets].every((value) => /^\/[a-zA-Z0-9_./-]+$/.test(value))) {
    throw new Error("Expected an exact Dashboard hostname, loopback upstream and absolute paths");
  }
  const escaped = site.replaceAll(".", "\\.");
  const block = new RegExp(`^${escaped} \\{\\r?\\n[\\s\\S]*?^\\}`, "gm");
  const matches = [...source.matchAll(block)];
  if (matches.length !== 1) throw new Error("Expected one caddy-fmt Dashboard site block");
  const previous = matches[0][0];
  const use = `import octopus_startup ${assets} ${upstream}`;
  const include = `import ${snippet}`;
  if (previous.includes(use) && source.split("\n").includes(include)) return source;
  const managed = [...previous.matchAll(/^[\t ]+import octopus_startup (\/[a-zA-Z0-9_./-]+) (127\.0\.0\.1:\d+)$/gm)];
  if (managed.length === 1 && !previous.includes("handle_errors")) {
    const oldInclude = `import ${managed[0][1]}/startup.caddy`;
    if (source.split("\n").filter((line) => line === oldInclude).length !== 1) {
      throw new Error("Managed startup snippet import is missing or ambiguous");
    }
    return source.replace(oldInclude, include).replace(previous,
      previous.replace(managed[0][0], `\t${use}`));
  }
  if (/handle_errors|octopus_startup|__octopus\//.test(previous)) {
    throw new Error("Dashboard already has custom error/startup handling; review its configuration explicitly");
  }
  const target = upstream.replaceAll(".", "\\.");
  const fallback = new RegExp(`(^[\\t ]+)handle \\{\\s*reverse_proxy ${target}\\s*\\}`, "gm");
  if ([...previous.matchAll(fallback)].length !== 1) {
    throw new Error("Expected one plain Dashboard catch-all; refusing to rewrite custom proxy settings");
  }
  const next = previous.replace(fallback, (_match, indent) => `${indent}${use}`);
  return source.replace(previous, `${include}\n\n${next}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, site, snippet, assets, upstream] = process.argv.slice(2);
  writeFileSync(output, configureStartup(readFileSync(input, "utf8"), site, snippet, assets, upstream));
}
