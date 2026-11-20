/**
 * `pnpm run app:pack` — build one installable Agentic App release from this
 * checkout and write it to a file.
 *
 * ── Why packing and publishing are two commands ─────────────────────────────
 *
 * This one produces bytes. It writes no database row, contacts no server and
 * changes nothing about what any host is serving. Handing those bytes to a host
 * is a separate, authenticated call (`POST /api/apps/install` — the `publish`
 * subcommand below, or the file picker on `/apps`), and activating what was
 * installed is a third, separate decision.
 *
 * That separation is the point: "whoever can run a build" and "whoever may
 * change what this host serves" are different permissions, and a single command
 * that did both would merge them.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```bash
 * pnpm run app:pack -- --out /tmp/session-plus.json
 * pnpm run app:pack -- --out /tmp/session-plus.json \
 *   --publish https://bot.example.com --token dt_xxx [--activate]
 * ```
 *
 * `--token` is an admin account's personal `dt_` key. A bearer credential is
 * accepted for writes (it is not ambient, so it needs no CSRF), and it must
 * belong to an account in `dashboard.admins` — the same rule the page enforces.
 */

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { packageHostLabel } from "@claude-bot/app-registry";
import { buildCheckoutBundle, bundleToWire } from "./session-plus-package.js";

interface Args {
  out: string | null;
  publish: string | null;
  token: string | null;
  activate: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { out: null, publish: null, token: null, activate: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--out") { args.out = value ?? null; i++; }
    else if (flag === "--publish") { args.publish = value ?? null; i++; }
    else if (flag === "--token") { args.token = value ?? null; i++; }
    else if (flag === "--activate") args.activate = true;
    else if (flag === "--help" || flag === "-h") { args.out = null; args.publish = null; }
  }
  return args;
}

async function post(base: string, route: string, token: string, body: unknown): Promise<void> {
  const url = new URL(route, base);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status} ${text.slice(0, 400)}`);
  process.stdout.write(`${route} → ${text.slice(0, 400)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = buildCheckoutBundle();
  const wire = bundleToWire(bundle);
  const digest = bundle.descriptor.packageDigest;
  const bytes = bundle.assets.reduce((sum, asset) => sum + asset.content.byteLength, 0);

  process.stdout.write(
    `package digest : ${digest}\n`
      + `host label     : ${packageHostLabel(digest)}\n`
      + `contract       : ${bundle.descriptor.permissionContractDigest}\n`
      + `assets         : ${bundle.assets.length} 个 / ${bytes} 字节\n`,
  );

  if (args.out) {
    const target = path.resolve(args.out);
    writeFileSync(target, `${JSON.stringify(wire)}\n`, { mode: 0o600 });
    process.stdout.write(`written        : ${target}\n`);
  }

  if (args.publish) {
    if (!args.token) throw new Error("--publish 需要 --token（管理员账号的 dt_ 密钥）");
    await post(args.publish, "/api/apps/install", args.token, { bundle: wire });
    if (args.activate) {
      // Deliberately opt-in. Installing is safe; activating changes what every
      // user's next page load runs, and that is not something a build script
      // should decide by default.
      await post(args.publish, "/api/apps/activate", args.token, {
        // The registry now serves more than one declared App, so every
        // mutation names its target. Derive it from the bundle we just
        // installed instead of carrying a Session Plus string beside it.
        app: bundle.descriptor.stableAppId,
        package_digest: digest,
      });
    } else {
      process.stdout.write("已安装但未激活 — 在 /apps 上决定是否切换,或加 --activate\n");
    }
  }

  if (!args.out && !args.publish) {
    process.stdout.write(
      "\n没有 --out 也没有 --publish,所以只打印了这次构建的身份。\n"
        + "用法: pnpm run app:pack -- --out <file> [--publish <url> --token <dt_...> [--activate]]\n",
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`app:pack 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
