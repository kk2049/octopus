# Dashboard restart page

`startup.caddy` lets the existing TLS ingress show a small, standalone loading
page during Bot drain, cold start, crash recovery and rollback. Browser sources
live in `packages/dashboard-web/public/startup/`; Caddy serves an immutable copy
outside the supervisor's changing checkout. The presentation follows DSH's
self-contained boot screen: centered wordmark, spinner and short status text.

The page returns **503**, `Cache-Control: no-store` and `Retry-After: 3`. Only
ordinary GET/HEAD HTML page navigations receive it. API requests and mutations
receive a JSON 503 on a proxy transport failure, with no retry. Responses from
a running backend (including 401/403/404/500) pass through unchanged. Runner,
DSH, mesh and Agent View origins keep their existing routes and trust boundaries.

The browser polls the public `/__octopus/deploy` projection and then
`/__octopus/ready`, every 2–2.5 seconds, with one cycle in flight and a
four-second timeout. Caddy
maps this to credential-free, query-free `GET /login` with a two-second header
timeout. Only an upstream 200 becomes 204. This is HTTP readiness, not a deploy
acceptance signal. The page waits for the supervisor's successful terminal
state before returning to the original path/query/fragment once service switching
has begun. During requested/claimed/building, a brief failed navigation returns
as soon as HTTP readiness recovers; preparing a build does not suspend the
serving version. Already-open Dashboard documents only show a top banner;
backend probes never turn that document into a loading screen. A healthy restored
old version shows an explicit rollback result and a return button. No failed
write is replayed. Older installations without a status projection retain the
HTTP-only reconnect behavior.

`status-monitor.py` runs under a separate systemd unit, independently of Bot.
It opens SQLite read-only (including WAL) each second, projects only the latest
intent id, bounded stage and timestamps, probes credential-free loopback login,
and atomically writes `/var/lib/octopus-startup/status/status.json`. Caddy can
read that public file but receives no database access. A checkout restored to
the intent's base during the health gate identifies `rolling_back`. Git SHAs,
requesters, ticket titles, raw errors and credentials are never published.
Snapshots older than eight seconds are treated as unavailable by consumers.

## Install after production authorization

From the landed checkout, review the exact candidate against the current
production Caddyfile:

```bash
python3 ops/caddy/install-status.py
sudo python3 ops/caddy/install-status.py --apply
```

The combined installer is specific to this repository's production Ubuntu
paths. It requires a clean, committed, landed checkout for `--apply`, installs
the observer under the runtime user, checks its fresh output, then invokes the
existing Caddy installer. It restores the prior observer unit if installation
fails; Caddy's installer owns its configuration backup and reload rollback.
Review-only mode does not change production.

Apply this **before** deploying the Bot optimization if that first restart
should already show the loading page. The installer copies the static files
and snippet to `/var/lib/octopus-startup/<commit>/`, validates the complete
Caddy configuration, saves a timestamped backup and reloads Caddy. It restores
the backup if reload fails. Bot is not restarted by this command. Later normal
deployments need no ingress changes; reinstall when edge assets or rules change.
The deployment service checks fresh status, installed content hashes and actual
served JS/CSS against the exact target Git commit before creating an intent.
The Dashboard displays this independent obligation even if earlier tickets were
marked accepted. Product acceptance also requires the running release's edge
resources to pass the check. Custom existing proxy/error rules are refused.

Defaults can be changed through `OCTOPUS_CADDY_FILE`,
`OCTOPUS_DASHBOARD_HOST`, `OCTOPUS_DASHBOARD_UPSTREAM` (loopback only), and
`OCTOPUS_STARTUP_DIR`. `--check` never changes production. For a custom site,
the equivalent operation is to import `startup.caddy` once at top level and
replace only the Dashboard catch-all with
`import octopus_startup <absolute-asset-directory> 127.0.0.1:9820`.

Rollback: restore the printed `Caddyfile.before-startup-*` backup, run
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, then
`systemctl reload caddy`. Keep old asset directories while referenced by a
live config or its rollback copy.
If removing the feature entirely, also disable `octopus-deploy-status.service`;
the resulting missing ingress obligation will remain visible and block another
normal full deployment until restored. Bot rollback alone does not uninstall
the independently hosted loading page.

## Verification

```bash
pnpm exec vitest run --project node --maxWorkers=1 ops/caddy
```

The integration fixture starts its own loopback Caddy and HTTP backend; it
never stops production. The browser test additionally requires Chromium and
can take an installed executable through `OCTOPUS_TEST_CHROMIUM`. Missing
test binaries are reported as skips. It checks the real CSS animation, CSP,
offline asset delivery, and automatic return to the original URL. Browser
specs remain outside the synchronous landing gate.

Caddy's [error routing](https://caddyserver.com/docs/caddyfile/directives/handle_errors)
distinguishes proxy transport errors from a backend's own error responses;
this distinction is intentional here.
