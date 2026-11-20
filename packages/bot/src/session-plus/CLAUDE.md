# Session Plus trusted host boundary

Session Plus is an isolated Agentic App host path, not a second authorization
system. Read these before structural work:

- `doc/adr/0001-session-plus-trust-boundaries.md`
- `doc/adr/0002-agentic-app-publisher-trust-and-capability-grants.md`
- `doc/development/session-plus-m2-m6-fable-design.md`
- `packages/session-plus-view/CLAUDE.md` for the untrusted browser half

## Identities do not imply one another

- Dashboard identity proves who is using the trusted page.
- App instance identity binds one opened release instance.
- Publisher trust controls whether publisher code may load. Releases built
  from this repository (`octopus:` publishers) are trusted without a consent
  row; only other publishers meet the consent page.
- Capability grants control which named operations a trusted provider may
  dispatch.

Never derive one from another. In particular, trusting a publisher does not
grant resource operations, and granting an operation does not trust a new
publisher release.

## Non-negotiable boundaries

- The App View receives no username, owner path, credential, capability,
  approval state, canonical resource path, or direct network endpoint.
- The View proposes bounded actions over its MessagePort. Trusted code resolves
  identity, instance, contract, provider, scope, and authorization.
- Treat every value sent to the View as declassified. A later React or browser
  bug must not expose a secret that was unnecessarily placed in boot data.
- Publisher changes invalidate publisher trust and capability intent records;
  neither decision silently transfers to a different package digest.
- A denial is data returned to the View, not an exception containing trusted
  stack text or filesystem paths.
- Do not add automatic retries for capability-bearing actions. A refusal may
  create a human approval request.
- Instance close, credential change, provider target change, release change,
  and host shutdown must revoke derived handles before asynchronous cleanup.

## Composition

- Shared release, manifest, identity, instance, View-package and projection
  mechanics live in `../app-core/`. Session Plus and the generic App registry
  both depend on that neutral layer; generic code must never import this
  composition root.
- Release assets describe data: module lock, composition, resource bindings,
  and permission-contract id. They never name provider implementations.
- Open an instance once, bind the trusted identity and authority into the
  handle, then dispatch through that handle. Do not pass identity again with
  every proposal.
- The trusted host may project `writable` or similar UX facts only from the
  same rights used to derive the capability. Such facts are never authorities.
- App backend agents use the same normalized dispatch path as human buttons,
  with agent-specific authority that excludes human auto-allow.
- Session writes and Agent interaction answers name only an opaque resource
  (plus, for an answer, the projected interaction id and bounded answer). The
  trusted Host re-derives owner/device/CLI/session from the resource id it
  minted — never from the proposal's own device or session fields — and
  re-checks that owner against the instance. The roster frame is not the
  binding: it is a truncated recency window, and a session that ages out of it
  is still readable and must stay writable (ticket #208).
- Existing-session writes may additionally carry one bounded `model` and one
  provider-valid `effort`. The Host derives the provider from that opaque
  resource, validates model syntax and the closed effort ladder, freezes both
  values into the operation fingerprint/Runner args, and keeps the existing
  `append_session` authority. The provider remains authoritative for whether a
  syntactically valid model is supported. The device refuses external tmux/TUI
  injection and an in-flight steer instead of silently dropping either value.
- A current roster row may carry the complete trusted pair
  `inputMode: "parent_owned"` + `parentResourceId`. Such a Codex Multi-Agent V2
  child is observable but rejects append/resume/takeover/fallback/interrupt;
  the only navigation target is the exact opaque parent resource. A roster row
  remains unnecessary for ordinary writes (ticket #208): if an older or
  truncated projection lacks this fact, the Runner still checks
  `canAcceptDirectInput` before dispatch and never substitutes `thread/fork`.
- `fallback_session` is a human-only Codex action over that same opaque
  resource. The Host verifies the projected provider, freezes only
  `account_fallback: true`, and lets the device-local Runner choose the
  alternate configured account and trusted rollout path. The View never names
  a slot, account home, quota response, or session path; failures are returned
  once and never retried automatically.
- An answer additionally requires that exact interaction to still be present
  and answerable in this instance's projection (roster runtime or transcript
  window), and refuses agent principals. The device decides whether it is still
  pending. The provider prompt is the approval surface; this action never
  becomes a standing capability grant.
- Pin、文件夹、custom title 与 completed-turn review 都是 App-owned durable preferences，
  不是 provider session mutation。它们只使用 opaque session resource，不花 Gate operation，并持久化到
  App event stream。review 额外携带当前投影里的有界 completion timestamp，projector 只前进不回退；
  标题空值清除覆盖，非空标题最多 48 个 Unicode code point。文件夹 id 由 View 铸造，动作拒绝越界
  （64 个文件夹、32 字名称、总计 2,000 个成员、单次 64 个会话），投影折叠对历史事件再执行同一组上限；
  删除文件夹是 human_only，新建/改名/归档允许 App agent 在用户要求时调用。
- 收藏与文件夹成员是“保留集合”：roster 刷新在 runner 平面本次读取已经成功（未要求批准）后，按设备用同一
  `list_recent_sessions` 词元带 `ids` 精确补取窗口外的这些会话（`session-resource/kept-sessions.ts`，每实例
  60 秒缓存，失败不缓存、不重试），并让窗口选择永远保留它们。离线设备与 bot-host 平面不补取，View 显示
  “不在当前名册”的占位行。
- 每个 instance 最多同时跟随 64 个独立资源，尾窗重复读取复用订阅；`close_session` 只撤销该资源的读取，
  超出跟随预算仍可读取新会话，只暂停最早的 follow 并投影 `paused`；显式刷新可重新跟随。关闭
  同时使先前在途 tail 失效。旧 listener 不能重开已关闭标签，单资源拒绝不终止其它订阅。
- `open_session` 的尾部读取若只是设备暂时答不上（Gate `failed`/`unknown`，映射为 `resource_failed`：部署后 Runner
  尚未重连、链路抖动），照样开始跟随：跟随的每次读取都过同一 Gate，期间投影 `reconnecting`，设备恢复后自动补全；
  只有 `resource_denied` 或需要审批才不跟随。跟随单飞但不丢唤醒：读取进行中到达的设备推送会在本次读完后立即再读
  一次；设备真正推送过一次后才把兜底轮询放宽到 30 秒（2026-11-12，修复“输出要等手动刷新/30 秒后才出现”）。
- `transcriptStatuses` 按 resource 分键，旧单 `transcriptStatus` 只供回滚兼容。
- `open_session` 的回包无论是否与另一请求并发，都必须与 instance 当前 transcript 窗口协调。请求开始前
  已经污染的旧缓存不能靠“await 期间对象是否变化”识别；来源 version 决定重叠内容，绝对 offset 只负责
  拼接连续历史前缀与新尾部，外层 App revision 不参与 transcript freshness。

## Configuration and failure

- Supported public origins are either one pinned `view_origin` or the
  `app_domain` form that gives each release its own host. They are mutually
  exclusive and invalid combinations fail startup.
  Explicit `shared_origin: true` is a third, mutually exclusive deployment
  shape using digest paths on `dashboard.public_url`. It keeps the opaque
  sandbox and MessagePort recovery; it makes no per-App cookie/host isolation
  promise. See `doc/runbooks/mirror-migration.md`.
- Publication serves one self-contained document. Unknown host/target and
  stale build/package digests fail closed.
- Runtime/State child-process startup is transactional: partial startup closes
  everything already opened.
- Every `start_session`, same-machine or split runtime/execution, enters the
  Runner's provider-native managed control plane. The device keeps the old
  `independent_cli` field only for rollback compatibility; this trusted Host
  no longer emits it and the View still cannot select a lifecycle policy.

## Publishing is not deploying

The host serves the release the registry pointer marks active. `deploy.sh` moves
trusted code and deliberately leaves that pointer alone, and nothing seeds it
from the checkout — so a View change is live only after pack → install →
activate. Automatic only for `kind: "app"` tickets
(`devpipe/app-ticket-refresh.ts`). Procedure: `doc/runbooks/app-release.md`.

## Focused verification

```bash
npx vitest run --project node --maxWorkers=1 packages/bot/src/session-plus
npx vitest run --project session-plus-view --maxWorkers=1
```
