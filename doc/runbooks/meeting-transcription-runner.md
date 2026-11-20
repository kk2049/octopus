# Fixed MOSS transcription on an owned Runner

The Runner owns the MOSS process, immutable audio transfer and persistent job
receipts. Research supplies a fixed device and a trusted recording identity.
It does not distribute workers through generic shell commands. The protocol and
MCP descriptors are derived from one declaration, and the independent
`meeting-transcription-runner-v1:<owner>` Object does not expand the legacy
Runner account Object. Device-token changes revoke the new plane as well.

## Device configuration

The Linux device must have the reviewed MOSS environment already installed.
The feature does not download weights, copy credentials or open an HTTP port.
Write a private configuration at the actual Runner scan home's
`.octopus/runner/meeting-transcription.json`; restart/upgrade through the normal
Runner service/update flow after checking managed work is idle. The following
is the gpu-box deployment shape; confirm the two hashes and paths locally:

```json
{
  "version": 1,
  "jobsRoot": "/home/lht/meeting-runs/runner-jobs",
  "script": "/home/lht/infra/meeting-notes/run-dialogue-4090.sh",
  "scriptSha256": "cd379dc45d8c846dc2e0812213cb1cdee5b60f2058f74f11ca1a8fa35ebc6dc1",
  "pipeline": "/home/lht/infra/meeting-notes/dialogue.py",
  "pipelineSha256": "0c28f759f9d1dc03769b2b1d5f3df695e3275834d8c52ede4c58c3641cdf76fa",
  "python": "/home/lht/infra/meeting-notes/.venv-dialogue/bin/python",
  "modelDir": "/home/lht/.cache/huggingface/hub/models--OpenMOSS-Team--MOSS-Transcribe-Diarize/snapshots/704aa4a9c304e8520be88901e0d1960158ef5b15",
  "deadlineMs": 28800000
}
```

The configuration must be owned by the Runner uid, mode 0600 and a regular file.
The job root is owned/private mode 0700. `deadlineMs` is optional, 60,000 through
28,800,000; the upper bound cannot be increased through RPC. Paths are absolute
and device-local. The script and pipeline hashes are checked before launch and
on periodic readiness discovery. Module availability, ffmpeg, model config and
GPU tooling are probed without loading the model on every inventory request.
The fixed pipeline verifies the existing model lock/weights before inference.
Updating scripts intentionally requires updating their local pins.

The control site is the only site that receives this capability. Check
`octopus-runner sites list`; a currently online secondary site's shell support
does not imply it controls fixed jobs. Move control with the existing
`sites control <site>` command only after reviewing the device's active work and
site policy. The inventory reports missing config, invalid config, disabled
machine operations, unsupported platform or environment unavailable explicitly.
The standard provider catalog preserves the distinction between known but
unavailable, old/unsupported Runner and offline device.

## Protocol and recovery

`meeting_transcription_begin` binds `job_key`, `input_sha256`, `input_bytes`
and `title`. Repeating that exact request reopens its receipt. `upload` adds
`offset`, canonical base64 `data`, and `chunk_sha256`. Existing bytes must match;
gaps, changed bytes and out-of-budget chunks are refused. `start` checks the
whole file before persisting a queue entry and absolute deadline. `status` only
reconciles the original operation. `cancel` is monotonic and signals only a
worker whose PID and Linux start ticks still match. `read` accepts only a file
named by the published manifest, plus bounded offset and length.

Since 2026-10-20 a recording has no size ceiling: it moves in 256 KiB windows,
`start` hashes it by streaming reads, and each chunk write first checks that
the job volume keeps 1 GiB free. The advertisement keeps `max_input_bytes`
at 64 MiB for Heads before that date and states the real ceiling in
`max_recording_bytes`; a current Head names an older Runner's 64 MiB instead
of sending, so Runner and Head can be updated in either order. What MOSS can transcribe is bounded
by time (deadline, token budget, three recovery windows); an uncovered tail
ends as `needs_review`, never as complete.

The caller never supplies owner, script, model, cwd, output path, process id or
shell. The trusted capability grant supplies owner and device; the App binding
supplies the recording identity. Every response rechecks job/input identity,
chunk byte counts, exact EOF and artifact digest. Closing/revoking a Head
consumer ends future calls without silently killing or replaying its detached
job. A later authorized consumer can reopen the same job.

Launch intent is durable before spawn. A Runner restart reattaches through the
original `pid.json` and `exit.json`. A vanished process or uncertain pre-spawn
window becomes `orphaned`; invoking start again does not restart it. Failed,
cancelled and timed-out jobs also do not restart. A deliberate new transcription
requires a new trusted recording/job version and preserves the old evidence.

A successful exit is checked again against strict export integrity. Unclosed raw
output, incomplete parsing, token exhaustion, invalid timestamp/speaker data,
long tail gaps, or missing recovery sources/maps cannot become successful.
Maximum three recovery windows preserve source raw strings, timestamps, speaker
permutations and seam/deduplication records. Ambiguous mappings retain partial
text with `needs_review`. Do not treat agreement of machine labels as identity
verification or human listening.

Artifacts are at most 8 MiB each and 64 MiB in aggregate, published read-only
with SHA-256 and file identity. The source-run evidence is included in the same
fixed artifact manifest. Jobs contain private recordings/transcripts. At the
256-job admission bound, archive only known terminal, unused job directories
under the device's established project archive; retain the index/key mapping.
Do not delete recordings or unique evidence as a routine capacity workaround.

## Single-device rollout and rollback

Normal `octopus-runner update` downloads the site's active bundle. The current
site bundle registry is global, so activating a candidate there is not a
single-device canary. A deliberately scoped canary must:

1. Record the exact target device, installed bundle digest, sites policy and
   managed-work/GPU idle evidence. Retain the private prior bundle/config.
2. Use the existing `sites updates none` command on that device only. Stage the
   reviewed candidate locally; verify byte length, SHA-256 and `node --check`.
3. Reuse Runner's `stageBundle` implementation for atomic installation and its
   previous-bundle backup. Use the existing normal `octopus-runner restart`
   lifecycle, not a raw process kill. Preserve identity/tokens and other devices.
4. Confirm the target bundle digest and site connection, read the device config,
   and run a short real recording through Runner's dedicated `handleRpc` path.
   Until Head is separately deployed, local RPC validation and a real-socket CI
   Gate test must not be described as production Head/App availability.
5. On failure, perform at most one bounded rollback after proving the installed
   digest still belongs to this canary. Restore the recorded old bundle, use a
   normal restart, and restore the recorded updates/control policy. If another
   updater changed it, stop rather than overwriting that new version.

A successful pre-Head canary remains explicitly pinned with `updates none`;
this is temporary rollout state, not a permanent upgrade policy. Restore its
recorded update site once the approved active site bundle contains this feature
at the intended revision and its health has been verified. Do not set a cron,
background model poll or unbounded retry to wait for that deployment. Head/App
publication remains a separate explicitly authorized deployment.


## 2026-09-26 gpu-box canary record

Only `lht/gpu-box` was changed. The reviewed source was based on
`42f6b8f7651155e551a5c190a61c28e4badacb4e`; implementation commits were
`03301f45` and `80cc0994`. The candidate was built and tested in the dedicated
`octopus-ali-4090-ci` workspace. No Head/App code or global active bundle was
published for this canary.

Before the change, the legacy `primary` site was unreachable (its current TLS
certificate did not match `bot.example.org`), yet it was the device's machine
control site. The current `octo` site was online and provided updates but did not
control the machine. The existing `sites control octo` operation repaired this
specific device route; it retained both site registrations and all credentials.
No user grant was expanded. `sites updates none` pinned only this device so the
old active Head bundle could not immediately overwrite the candidate.

The existing Codex app-server was inspected through read-only
`thread/loaded/list` before restart: no loaded threads at 15:38:38 UTC. The
managed recovery journal was absent, and the GPU had no compute process.
Normal `stageBundle` and `restart` completed at 15:39:31 UTC. At 15:41:05 UTC the
service was active with PID 473156; the `octo` site reported the candidate SHA,
and the new shared app-server again had no loaded threads. No active Agent was
stopped and no rollback was required.

| Item | Recorded value |
| --- | --- |
| Previous bundle SHA-256 | `db3bb0ac70687087104f2275538f06fb1258523e51873bc36cd15c542fd62bcc` |
| Installed bundle SHA-256 | `12b6a3f9582f3d2df7aec683295c52c417c0cb0eedc5853484aa32795b653771` |
| Installed bundle bytes | `2391220` |
| Smoke recording SHA-256 | `45501ee9e99ced00567dc5838d83a2784a656749efc301da953781b70229d491` |
| Smoke dialogue SHA-256 | `0a0133d969c29590c200248c0b89290f7426bc44592fa8c864d9cf91f1d60f8d` |
| Smoke receipt file SHA-256 | `9c2b8ae748743b9ed50ff40c4c76921ef879a2ced4d751d169c119912dd10097` |
| Current control site | `octo` |
| Current update site | `none` (temporary canary pin) |
| Dedicated config | `/home/lht/.octopus/runner/meeting-transcription.json`, mode `0600` |
| Persistent jobs | `/home/lht/meeting-runs/runner-jobs`, mode `0700` |
| Prior bundle and policy | `/home/lht/.octopus/runner/canary-meeting-20260926/standalone.before.js`, `/home/lht/.octopus/runner/canary-meeting-20260926/sites-policy-before.json` |
| Final device evidence | `/home/lht/.octopus/runner/canary-meeting-20260926/canary-state-after.json` |

The real-audio acceptance used a private 30-second excerpt from an already
provided recording. It invoked the actual dedicated Runner `handleRpc` methods
with the device-owned configuration, before the old resident Runner was upgraded
(the old code did not read this new configuration). Thus exactly one manager
owned the canary journal during inference. The upgraded resident subsequently
loaded the same terminal journal.

The 960078-byte recording was transferred in four chunks and completed in
14.165 seconds. Its transcript had six segments, last end 29.47 seconds and
0.53 seconds of trailing audio; raw output was closed, token exhaustion was
false, and strict completeness passed. All 13 published primary/source artifacts
were read in bounded chunks and matched their SHA-256. Duplicate chunk, duplicate
start and a fresh manager reopening the same completed key all passed without
re-running inference. Real WebSocket tests independently cover
owner-bound Gate → Runner dedicated RPC → fixed worker → immutable artifact.

The private smoke receipt is
`/home/lht/meeting-runs/runner-capability-acceptance-20260926/rpc-smoke.json`;
job key is
`2b4a728c537250f797d8915c3cecaa5e10c5c486ff9c6b96bc64abf64a4817fd`.
This is transport/machine-completeness evidence, not a human accuracy or voice
identity certification. No real business card or external message was created.

### Pending Head configuration and publication

A read-only check of `/home/ubuntu/lht/octopus-dev/config.yaml` on
`octopus-service` found no `research_v2.moss` configuration. At the separately
authorized normal Head deployment, merge this exact routing fragment into the
existing configuration (preserve all other keys):

```yaml
research_v2:
  moss:
    device: gpu-box
    timeout_ms: 28800000
```

Head must include the matching six-RPC gateway allowlist, inventory parser,
independent capability composition, MCP registration and research consumer. Its
MCP `transcription` operations require their own explicit grants. Grant the six
`meeting_transcription_begin`, `meeting_transcription_upload`,
`meeting_transcription_start`, `meeting_transcription_status`,
`meeting_transcription_read` and `meeting_transcription_cancel` operations only
after that composition and route are deployed and the owner can inspect the
actual readiness. Use the existing `/permissions` MCP subject; `autoAllow` is a
separate owner decision, and without it each operation follows normal Gate
approval. Existing MCP execution or discussion permissions do not gain these
rights. The research App uses its own updated closed permission declaration and
trusted recording binding, not the MCP token's grant. Follow its standard App
permission consent when enabling that updated composition. This canary changed
no persistent user permission rows. The old live
Head does not yet provide those tools or retain the new inventory field; the
local Runner smoke must not be reported as production Head/App availability.

Once the approved active site bundle includes the feature and its health is
verified, restore the previously selected update source with:

```sh
node /home/lht/.octopus/runner/standalone.js sites updates octo
```

Retain `control_site=octo` for the current live service. There is no permanent
poller or automatic timer for this pending deployment.

### Exact bounded rollback for this canary

First recheck no active managed/transcription work and ensure the installed
SHA still equals the candidate above. The task-local staging helper uses the
existing `stageBundle` implementation and compares both old/new digests before
writing. Run at most one rollback, then inspect health; do not loop:

```sh
node /home/lht/.octopus/runner/canary-meeting-20260926/stage-canary.mjs /home/lht /home/lht/.octopus/runner/canary-meeting-20260926/standalone.before.js 12b6a3f9582f3d2df7aec683295c52c417c0cb0eedc5853484aa32795b653771 db3bb0ac70687087104f2275538f06fb1258523e51873bc36cd15c542fd62bcc
node /home/lht/.octopus/runner/standalone.js sites control primary
node /home/lht/.octopus/runner/standalone.js sites updates octo
node /home/lht/.octopus/runner/standalone.js restart
```

This restores the old control policy, including its recorded offline primary,
and preserves the private config and all job evidence for review. A newer bundle
or active work is a reason to stop and review, not to overwrite or interrupt it.
