# First-party meeting transcription

This module gives a registered owner a scoped grant over a fixed Runner MOSS
pipeline. It is an independent `meeting-transcription-runner-v1` Object and slot;
it neither extends `runner-account-v2` nor accepts executable/path selectors.

The single closed action declaration lives in
`packages/runner/src/meeting-transcription-protocol.ts`. The typed-port contract,
MCP descriptors, Gate operation table, device RPC methods and request validation
are derived from it. Six operations cover begin, upload, start, status, read and
cancel. Device inventory and the standard `RunnerProviderCatalog` expose real
readiness, including an explicit unavailable reason.

Trusted composition constructs `MeetingTranscriptionCapabilities` with the
shared Runner `CapabilityService`, transport, registered-user and device checks,
and calls `attachToRunnerLifecycle(runnerCaps)`. Keep the returned detach in the
composition's rollback/stop path. Consumers bind a specific owner/device and
close their grants at the end of their lifecycle.

`McpSurface` mounts the exact `MEETING_TRANSCRIPTION_MCP_TOOLS` when its
`meetingTranscription: { capabilities, device }` option is composed. The separate
`transcription` group requires explicit `service:mcp` operation grants; existing
execution/discussion grants do not expand. Public MCP and opted-in managed Agent
account tools use the same Gate, pending approvals and revocation lifecycle.
Owner comes only from authentication; device comes only from deployment config.
`mcpSubjectEntry({ transcriptionComposed })` and `accountOperations(owner)` keep
the permission projection aligned with actual composition.

The research consumer in `research-canvas/moss.ts` uses only these dedicated
operations. Every awaited response rechecks consumer authorization and immutable
job/input identity. It transfers bounded chunks, validates all final artifacts,
and preserves the Runner receipt in recording evidence. No generic execution
fallback exists.

The Runner owns private configuration, persistence, launch intent, PID identity,
concurrency, fixed worker code, bounded recovery and artifact publication. See
`doc/runbooks/meeting-transcription-runner.md` for configuration, staged device
updates, rollback and the distinction between a Runner canary and Head release.

Tests cover upload CAS, restart without replay, cancellation/deadline, source
integrity, immutable reads, provider readiness, a real WebSocket Gate/worker
round trip, MCP discovery, approval collection and post-await revocation.
