# Session Channel Contract — `session-channel/v1`, `session-channel/v2`

Provider-neutral, owner-bound input and bounded activity projection for an
interactive agent harness. The contract contains no Feishu identity, chat id,
username, endpoint, device, path, model, credential, grant, or raw harness
event. Those are deliberately absent rather than filtered.

The trusted host binds an instance to one owner before exposing this port.
`bindingRef`, `sessionRef`, message ids and cursors are opaque equality tokens;
none of them is an address. Text-only v1 accepts `followup` or explicit
`steer`, and exposes only the closed activity vocabulary in `projection.ts`.

`session-channel/v2` (`contract-v2.ts`, 2026-10-20) is v1 with one change:
`send.content` may be as long as a session prompt — 384 KiB of UTF-8, the
runner's `SESSION_PROMPT_MAX_BYTES` — instead of v1's 16,384 characters. The
wire carries it in its one oversized slot (384 Ki characters); the byte budget
is `sessionTextProblem`, refused as `too_large`, never truncated. v1 stays as
is because its device-side readers check the old bound. Operations, refusals,
receipts and activity paging (a window: 64 events / 64 KiB) are v1's. A device
adapter serves v2 under `octo_session_channel_v2`; Tentacle keeps every name in
`SESSION_CHANNEL_TENTACLE_TOOLS` owner-bound and unshareable. No in-repo
consumer exists since the Feishu → dsh channel service was removed with the old
composition root (2026-10-15); the device adapter lives in octo-tentacle.

Verification:

```bash
node_modules/.bin/vitest run --project node packages/session-channel-contract --maxWorkers=1
npx tsc --noEmit -p packages/session-channel-contract/tsconfig.json
```
