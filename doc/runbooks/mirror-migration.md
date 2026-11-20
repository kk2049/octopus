# Mirror deployment and reversible state transfer

A mirror is an independent Octopus control plane populated from a snapshot.
The same Runner processes can connect to both sites, so provider sessions,
workspace state and process ownership remain on their original machines.
Backend databases are independent. This procedure does not merge two SQLite
histories or move a live TCP/WebSocket connection between servers.

## Public IP deployment

```yaml
dashboard:
  public_url: https://192.0.2.10:444
  runner_public_url: wss://192.0.2.10:444/octopus-runner/v1
session_plus:
  enabled: true
  shared_origin: true
  view_host: 127.0.0.1
  view_port: 9821
```

Remove `app_domain`, `view_origin`, `app_scheme`, `app_public_port` and the
on-demand certificate ask listener in this mode. The static View listener
receives only `/__octopus/apps/app-<20-hex>/` and the equivalent `index.html`
path. The digest selects an installed release. Queries, traversal spellings,
unknown releases and unexpected Host headers are refused. The trusted page
keeps an origin for CSP and a separate immutable URL for its iframe.

Proxy those paths directly to the local View listener; strip `Cookie` and
`Authorization` there, and disable access logging for them. Proxy the remaining
dashboard routes to the local dashboard. Route `/octopus-runner/v1*` separately
to the Runner gateway listener (normally loopback port 9910), which owns the
WebSocket upgrade. The App document
stays self-contained. Its iframe still has exactly `allow-scripts
allow-downloads`, an opaque origin, no direct network access and the existing
MessagePort generation/reconstruction protocol. Host/cookie isolation between
Apps is intentionally absent in this explicit mode. Default domain deployments
retain their existing isolation requirements. External trusted hosts should
use `view.url` when present and `${view.origin}/` otherwise.

Use a publicly trusted IP certificate. Let’s Encrypt IP certificates use its
short-lived profile; Certbot 5.4 supports HTTP-01 webroot validation. Keep TCP
80 reachable for challenges even when application HTTPS is on 444. Validate
renewal, configure frequent renewal checks and a deploy hook that reloads the
proxy. Caddy behind cloud NAT may need `default_sni <public-ip>` for clients
that send no SNI on an IP URL. Never disable TLS validation on the Runner.
See [Certbot IP support](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

## Initial mirror

1. Leave the source's public ingress, supervisor and Runner services running.
   Export backend data and configuration, with encrypted local and 4090 copies.
   Verify hashes and decrypt/read the archive. A live export uses SQLite's
   backup API per database; it is not a coordinated cross-database snapshot.
2. Create a new destination data directory. Preserve canonical state paths
   when stored release/artifact paths are absolute. Import accounts, backend
   history, capability data, App releases and App state together. Keep provider
   homes and logins on their Runners. Provider credential symlinks are recorded
   as omitted; snapshot tools never follow them into another home.
3. Derive destination configuration separately: local bind ports, public IP
   URLs and shared-origin hosting. Preserve required backend identity secrets.
   Use `channels: {}`, `app_agents.enabled: false`, `fleet.enabled: false` and
   `selfhosting.enabled: false` during the mirror. Do not start a second channel
   consumer, deployment worker or autonomous App-agent queue from copied data.
4. Build the landed source in an isolated destination checkout. Initial
   container bootstrap uses its own service and startup health gate; it must
   not call the source site's `deploy.sh`, which would restart the live source.
   Preserve the empty staging container until the mirror passes health checks.
5. Upgrade idle Runners through their supported service lifecycle, with local
   configuration/bundle backups. Keep each original gateway as `primary`, pin
   updates to `none`, then add the mirror site. Check both sites' registration,
   workspace enumeration and session projections. An offline/busy device stays
   on its working installation until it can be updated safely.
6. Validate existing AWS Codex sessions through the new site. No provider login
   or provider-machine migration is part of this mirror operation. Ordinary
   CLI MCP remains attached to the designated control site. Changes made to
   Runner-owned sessions can appear on both sites; account settings, App
   preferences, tickets and other database writes do not replicate continuously.

## Transfer tool

`scripts/ops/state-transfer.py` works in either direction. Run it with access
to the source/destination data and a mode-0600 GPG passphrase file. Keep that
key separately from the remote encrypted backup. `backup-4090` is an SSH alias;
its transport must remain reachable during the intended recovery scenario.

```bash
python3 scripts/ops/state-transfer.py snapshot \
  --data /state/data --config /state/config.yaml \
  --output /backups/source.tar.gz.gpg --key-file /private/backup-key
python3 scripts/ops/state-transfer.py verify \
  --archive /backups/source.tar.gz.gpg --key-file /private/backup-key
python3 scripts/ops/state-transfer.py replicate \
  --archive /backups/source.tar.gz.gpg \
  --remote-host backup-4090 --remote-dir /home/lht/octopus-backups
```

Transfer the encrypted archive and its checksum over SSH to the destination,
then verify it there. For a new mirror directory only:

```bash
python3 scripts/ops/state-transfer.py restore \
  --archive /backups/source.tar.gz.gpg --target-data /state/data \
  --key-file /private/backup-key --backup-dir /backups \
  --remote-host backup-4090 --remote-dir /home/lht/octopus-backups \
  --new-target --allow-live-mirror
```

An existing destination requires evidence that its service stopped:
`--stopped-container <name>` or `--stopped-pid-file <recorded-bot-pid-file>`.
Stopping a supervisor alone is insufficient when `KillMode=process` leaves its
Bot alive. Follow the normal drain/shutdown workflow first. Never manufacture
a dead PID file to satisfy the check.

Before replacement, the tool creates and verifies an encrypted local snapshot
of the destination, copies it to the remote backup and checks the remote hash.
A failed backup prevents replacement. It then renames the old data directory
to `data.before-<timestamp>` and installs the verified incoming data. A receipt
records source/backup hashes and the retained directory. The destination's
configuration stays in place; its ownership is preserved. Keep enough disk
space for temporary verification, the incoming tree and retained preimages.
An exclusive file lock permits only one replacement per destination; keep the services stopped
throughout export/replacement and health verification.

## Final cutover or reverse cutover

The user must first accept the mirror and explicitly request cutover. Declare
which backend is authoritative. Archive both histories before discarding any
mirror-only writes; they are recoverable from backups, not automatically merged.

Before this step, build the destination at the source's version or a verified
compatible newer version. A reverse migration of newer database state must not
blindly start an older AWS binary; restore the matching source release first.

Drain new task submissions and finish active work on both sites. Stop both
backend writers cleanly while leaving Runner/provider machines intact. Export
the authoritative source with its stopped-container/PID check, producing a
`quiesced: true` archive. Replicate/verify that source archive locally and on
4090. Restore it to the stopped target with a second local/remote backup of the
target. Do not pass `--allow-live-mirror` for final replacement.

Start and verify the target: account counts, history samples, App releases,
capability policies, Runner registrations and one bounded task. Move Runner
`control_site` and `update_site` to the accepted target while tasks are stopped.
The target WebSocket connections already exist; stop or disable the obsolete
connections only after validating the target. Enable channel consumers and
autonomous/deployment workers at one site only. DNS changes are optional when
the chosen public URL is the IP. Browser cookies for the old domain do not
become cookies for the IP; users may need to sign in again.

For rollback, freeze target writes, retain fresh backups and choose whether the
authoritative history is the pre-cutover snapshot or the target's newer data.
Run the same export/verify/replace steps in reverse, then return Runner control
to `primary`. Never start both sites' autonomous writers against separate copies
and describe that as synchronized failover. Moving provider logins, model
forwarders, campus SSH gateways and the development execution environment is a
separate step before decommissioning AWS.
