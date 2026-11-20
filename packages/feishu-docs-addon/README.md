# Octopus Agent for Feishu Docs

A native Feishu Docs widget that puts one Octopus Agent session into a
document. Feishu provides the collaboration; Octopus keeps running the Agent on
its owner's own Runner device.

| Who | Sees | Can do |
|---|---|---|
| The session's owner (Feishu account mapped to the Octopus account that owns it) | live conversation, status, every file the agent mentions | send tasks, stop the Agent, fork it, freeze a snapshot, switch, remove or start an agent, choose speakers, share the session's workspace, preview the collaborator view |
| A speaker: a member the owner lets talk to this agent (an Octopus account with a Feishu identity) | the same as any reader | send tasks (their name heads each message), stop the Agent, fork their own branch |
| A member the owner granted the session's workspace (an Octopus account with a Feishu identity) | the same, plus files inside that workspace | read-only |
| Any other member of the configured Feishu tenant who can open the document | the same live conversation, status | nothing else — read-only, no files |
| Anyone outside the tenant | the card's labels only | nothing |

The owner's agents can do the same placing and starting without the card, and
can keep visual boards in documents, through the Octopus MCP tools
`feishu_doc_place`, `feishu_doc_board`, `feishu_doc_remove` and `session_start`
(below). None of
these actions raise approval cards; the owner receives a Feishu message for
every placement, removal, new agent, workspace grant change, and every file
another member opens (owner decision, 2026-10-18).

## Using it

1. In a document, insert **Octopus Agent** from the `/` block menu. The first
   time, the menu may not list it: open **More Add-ons** at the bottom of the
   `/` menu and add it from **Company add-ons**.
2. The card signs in with your Feishu identity by itself (a silent one-time
   code). If your Feishu account maps to an Octopus account and you can edit
   the document, it lists your sessions; pick one and confirm **放进文档**.
3. From then on everyone who opens the document sees the conversation update
   live. You type tasks into the card (⌘/Ctrl+Enter), stop the Agent while it
   works, or open it larger (**放大查看**, a 1040px modal) or beside the
   document (**侧边栏**, Feishu's fixed-width FloatCard).
   The header doubles as a **status bar**, readable even with the card folded
   down to its header (it then becomes one line): the pill says 工作中, 等你回答 /
   等你批准 (the Runner reports the agent blocked on its owner), 已完成 · 未读,
   已完成 or 空闲; after it, how long the current turn has run, how long the
   agent has waited, or how long the last turn took (from your last message to
   its last reply) and when it ended. A reply counts as read once the owner's
   card is open tall enough to show the conversation; that read point is kept
   per session (`feishu_docs_shares.read_at`, migration 90), so reading in one
   card clears every card of the same session. Viewers never see unread.
   A frame carries the newest messages (each up to 12 000 characters, 300 000
   in all); **加载更早的消息** at the top reads the page before them, back to
   the conversation's start, and a longer message offers **展开全文**. A message
   or task sent from a card may be as large as one session prompt (384 KB).
   Every task sent from a card ends with one line naming the document it was
   sent from (title and document id), so "change this in the document" points
   the agent at this one. A send the device cannot confirm yet shows a yellow
   notice rather than an error; it is followed for ten minutes and clears
   itself once the device finds the message in the agent's own record, and it
   is not shown while the agent is running or once a turn began after the send.
4. **移出文档并停止共享** in the card menu ends that card for everyone at once.
   The session picker's **全部停止** ends every card that shows a session.
5. **＋ 新建 Agent** (top of the picker, or the card menu) starts a new Claude
   Code or Codex agent on one of your devices. Device, working directory, CLI,
   model and effort are chosen on the form itself; by default the document's
   text goes along as the agent's starting context, whole, as long as the task
   still fits one session prompt (384 KB); a longer document is not cut: the
   agent is told its size and document id and reads it itself. The new session
   lands in the card once the device names it.
6. Paths the agent mentions (`results/fig.png`, `[a.ts](/abs/a.ts:12)`,
   `results/`) are clickable. A click opens the file or folder in place of the
   conversation: images, PDF, Markdown, CSV/TSV, JSON, text and code, audio and
   video preview inline; anything else downloads. **共享工作区文件** in the card
   menu chooses who besides you may open them: read access to the whole
   registered workspace holding the session's directory. The auto-registered
   Home workspace (your whole home folder) cannot be shared; register the
   project with `octopus-runner workspace add <dir>` first (the panel can ask
   the agent to do it). Absolute and `~/` paths work as well as relative ones:
   the owner's Runner says which registered workspace holds a path, since only
   it knows the home folder and the workspaces' real roots.
7. **Snapshots and forks.** **在下方固定快照** (card menu) puts a snapshot card
   right below: the conversation as it stood at the agent's last completed turn,
   kept by the bridge so it reads without the device and never changes. Use it
   for a milestone; the live card keeps going. Every card can be continued two
   ways: **发送** goes into the live conversation, **分叉** branches it — a new
   agent of the same owner, holding the conversation through the last completed
   turn (a snapshot: through its moment), in its own card right below, with
   your message as its first. Branches use each CLI's own fork (Claude's
   `forkSession`, Codex `thread/fork` with `lastTurnId`), run on the owner's
   device as the owner's agent, and leave the source untouched, so A and B can
   each fork the same milestone. A snapshot card only forks.
8. **允许谁对话** (card menu) chooses members who may talk to this agent here:
   send, stop and fork. Their messages start with `【发言人：名字，经 所有者 授权】`,
   so the agent and every reader know who spoke (the card shows the name above
   the message), and the owner gets a Feishu notice (coalesced per person for
   ten minutes). Whoever forks becomes a speaker of their branch.
9. **Read-only devices.** A session on a device that reports itself read-only
   (a Runner with `RUNNER_ALLOW_MACHINE_OPS=0`, e.g. one observing another
   Linux account's sessions) is shown to everyone, its owner included, with no
   composer, fork or speakers: the footer says so. The owner can still freeze
   a snapshot (reading is all it needs) or remove the card.

### From an agent

With the Runner's local MCP enabled for a device (Dashboard → overview: local
Agent bridge and default injection), Claude Code and Codex there get:

- `feishu_doc_place(document, session?, title?, after?, position?, snapshot?)` — insert a
  live card (with `snapshot: true`, a snapshot at the session's last completed
  turn — for the agent placing itself, the turn before the one asking) into a new-style document (link, token, or title: a title is looked
  up in the owner's own wiki and Drive, and several plausible hits come back as
  links to choose from instead of a guess). `session` defaults to `self`, which
  the Runner resolves from the calling CLI's process tree; a native session id
  (`$CLAUDE_CODE_SESSION_ID`, `$CODEX_THREAD_ID`), a `resource_id` from
  `list_recent_sessions`, or that listing's `title` (the name a terminal tab
  shows) names another of your sessions. `after` is a passage copied from the
  document (whitespace may differ, and it may run across neighbouring blocks)
  or a block id: the card becomes the next sibling of the block where the
  passage ends, so it stays inside an indented section. Where Feishu will not
  hold a card under that parent, it goes after the enclosing block instead,
  one level at a time. A title or passage that matches several places is
  answered with the candidates, never a guess.
- `session_start(prompt, directory, device?, provider?, model?, effort?, document?, title?, after?, position?)`
  — start an agent, optionally placing it into a document in the same call.
- `feishu_doc_board(html, title?, board?, document?, after?, position?)` — put a
  **board** into a document: one page of static HTML (tables, progress bars,
  status colours, inline SVG charts) that readers see live. The first call
  places the card (same position rules) and returns `board`; later calls with
  `board` replace the page, and every card showing it refreshes within ~15 s
  without another owner notice. Boards use the theme variables
  `--board-text|muted|border|surface|accent|good|warn|bad` so they follow the
  document's light/dark theme. Preview one with `pnpm preview:fixture` and
  `?scene=board`.
- `feishu_doc_remove(document, block)` — take one of the owner's own cards (a
  session card or a board) out of a document: end its share and delete the
  block. Blocks that are not Octopus cards, or are someone else's, are refused.

- `feishu_doc_outline(document, from?, limit?)` — the document as an outline an
  agent can address: every block in reading order with its id, kind (h1, text,
  bullet, table, image, …), depth and text.
- `feishu_doc_write(document, markdown, after?, position?, replace?)` — write
  Markdown as the owner. Feishu's own converter turns it into blocks
  (headings, paragraphs, lists, code, quotes, to-dos, tables); they go after a
  passage or block, at the start or end, or in place of one block (`replace`:
  the new content lands first, then the old block goes). The conversion runs
  as the app (it reads no user data); everything that touches the document
  runs as the owner. Markdown images are left out and reported: use
  `feishu_doc_image`. Long Markdown is converted in pieces cut at blank lines
  outside code fences and written in order at the same spot; a piece that fails
  is reported with how much was already written.
- `feishu_doc_image(document, path | data, name?, after?, position?)` — insert
  one image (PNG, JPEG, GIF, WEBP or BMP): `path` is read from the calling
  agent's own device with the owner's Workspace Files rights; `data` is base64,
  as much as one MCP call carries (12 million characters, about 9 MB). Images
  above Feishu's 20 MB single-request limit are uploaded in its 4 MB parts.
- `feishu_doc_delete(document, blocks)` — delete blocks by id; an Octopus card
  among them is taken out the way `feishu_doc_remove` would.

Edits are not approved one by one either: the owner hears about them in
Feishu, once per agent and document per ten minutes.

All docs tools route through one `agentTool` entry in `docs-addon.ts`, which receives
each tool's validated arguments whole; a test walks the tool specs so a field a
tool declares can never be dropped on the way.

A card copied into another document shows nothing until its owner confirms it
there (**在这篇文档中继续共享**) — copying a document must not silently widen
who can watch an Agent.

## Document-share card

An **Octopus 文档协作** card has two tabs: **文档助手** (below, under Document
assistants) and **访问密钥**. It opens on 文档助手 when the owner has turned
assistants on, else on 访问密钥; the tab a reader last chose wins after that
(remembered in their browser). The keys tab hands out access keys: each lets one external
agent (Claude Code, Codex, any MCP client) read (只读), or read and write
(读写), this document through Octopus over MCP. It works like an API-key page:
whoever can see the card takes a key of their own — a name, the rights, and its
ways in, shown once — and cleans up keys nobody needs, so the owner no longer
hands keys out one by one. It is a block of the same widget; its Record holds
only an anchor, `{"octopusShare":{"v":1,"anchor":"dsa_…"}}`, and everything it
shows comes from the bridge.

| Who | Sees | Can do |
|---|---|---|
| The card's owner (the bridge answers `viewer_is_owner`) | every key: name, 读写/只读, 待领取/生效/已暂停/已终止, how it was made, last use; **设置** | take a key; **显示接入命令** (a pending key their agent made, once); **暂停**, **恢复**, **终止** (asks first); set the self-serve level; make, reset or stop the claim link |
| Anyone else who can see the card: signed in, not signed in to Feishu, or outside the tenant | the same keys; those they took on the card while signed in are tagged **我的** | take a key within the owner's level; **删除** any key (asks first; a terminate) |
| Someone holding the claim link who cannot see the card (e.g. outside the organisation) | the claim page on the Octopus Dashboard, not the card | take a key there, within the same level and limits |

**Taking a key.** **领取访问密钥** opens a short form: 名字 (prefilled with the
reader's Feishu name when the host gives it; up to 60 characters) and 权限
(读写/只读, never more than the owner's level; the highest allowed is chosen).
Enter takes it, Esc cancels. The bridge answers the new key, already active,
with its ways in: a one-line `claude mcp add …`, a one-line
`printf … >> ~/.codex/config.toml`, and the endpoint with its
`Authorization: Bearer …` header for other clients. The card shows them once,
on top, in tabs (Claude Code / Codex / 其他客户端): each in a selectable
monospace box with **复制** (the Clipboard API; when the host's frame blocks it,
the text is selected for copying by hand) and the warning that they are shown
this once and work like a password. They live only in the card's memory, never
stored, logged or sent anywhere: gone once dismissed (**我已保存，关闭**), once
their key ends or leaves the list, or when the card reloads; the panel's own
re-reads keep them. A refusal stays in the form: the owner's level, the limits
(`limits.per_hour` keys taken per card per hour, `limits.active_max` keys not
yet terminated per card), a copy, a card missing from its document.

**The owner's own keys.** A key the owner's agent creates
(`feishu_doc_share_create`) is **待领取** (`pending`): it holds no token and
cannot be used until the owner takes it on the card. **显示接入命令** calls
`share-reveal`, which mints the token and activates the key in one step and
answers its ways in once, shown in the same one-time box. A second reveal is
refused (`not_pending`: 这个密钥的接入命令已经领取过；如果丢失，请终止后重新创建。).
A pending key can be terminated, never paused or resumed (`pending`).

**Settings** (the owner's, folded under **设置**). **自助领取** 关闭 / 只读 / 读写
(`share-settings`; the bridge's default is 读写) caps what readers may take.
**领取链接** is for people who cannot see the card: **生成链接** has the bridge
make one — a claim page on the Octopus Dashboard, its secret in the fragment
(`…#i=dsi_…`) — which the card shows as answered, once, like a key;
afterwards only **已生成于 …**, with **重置链接** (a new link; the old one stops
at once) and **停用**. The link carries the card's power, under the same level
and limits.

**The app's access.** Every key acts as the Octopus Feishu app, so a write key
writes only where the app may edit. When the bridge reports
`app_access: 'view'` while keys could write (self-serve 读写, or an active or
paused write key), or `'none'` while there are keys to use, a banner names the
app (`app_name`, else 「Octopus 应用」) and the fix: the document's owner adds it
under 「…」→「添加文档应用」 with 可编辑 (可阅读 when reading is all the keys
need); **重新检查** reads again.

The footer states the semantics in one line: 删除这张卡片会停止全部密钥，最迟
1 天；暂停、删除立即生效. Ended keys fold under **已停用的密钥**. An action shows
its pending state at once, then the key as the bridge returned it, then a fresh
read; a refusal keeps the key as it was and says why on it (`not_owner`,
`unknown_share`, `terminated`, `pending`, `not_pending` are worded; other
messages are shown as sent), and a key that ended elsewhere meanwhile stays in
sight with its reason. While the card is on screen it reads the keys again
every 30 s.

**Height and side panel.** Every surface fills its frame exactly: header,
tabs and footer stay put and only the body between them scrolls, so a short
panel leaves no blank strip under its footer and a long one never spills past
its block. Feishu desktop keeps an inline block at the height readers give it
(resizing it there is `Bridge.updateResize`, a collaborative document change,
so the card never resizes itself); only on Feishu's mobile clients does the
card hint its content's height (`Bridge.updateHeight`, 120–720 px, an open
conversation the full 720). **侧边栏** opens the same panel in Feishu's
FloatCard beside the document — the fixed side panel — where, as in the modal,
it fills its frame.

The bridge checks that the card is still in its document. `card_state:
'missing'`: not found, so every key is already stopped; a notice says so, and
the bridge checks again when the panel opens, so a refresh usually finds a
restored card. `'present'` and `'unknown'` show nothing: the check's lease is
the bridge's business.

Like the other cards it guards against copies, but the bridge decides: the
card sends the token its host reports (`host_token`, a docx or a wiki token),
and only `host_matches: false` shows **此卡片不属于本文档**, to the owner and
every reader alike — no keys, no buttons. `null` (the bridge cannot tell) shows
the keys; the owner, the only one the bridge names the document to (anyone
else gets an empty `document_id`), also sees a muted line naming it. Every take and
key action sends the same token, and a reader's take or delete counts only
where the bridge finds the card in that document. An `octopusShare` value the
card cannot read (a newer `v`, or a malformed one) shows an error, never an
empty Agent card. It also says when it cannot reach Octopus, or holds a card
the bridge does not know (`unknown_anchor`).

Bridge calls: `POST share-panel {anchor, host_token}`, `share-self {anchor,
host_token, label, rights}` and `share-action {anchor, share_id, action,
host_token}` (`pause`, `resume`, `terminate`) carry the `fda_` bearer when the
reader can sign in. When signing in is impossible (the host has no Feishu
login to give, or the bridge refuses the reader's code or tenant), the client
makes them without one for the rest of the session, and the bridge answers as
to any holder of the card: never the owner, nothing `mine`. `share-reveal
{anchor, share_id}`, `share-settings {anchor, self_serve, host_token}`,
`share-invite {anchor, op}` and pausing or resuming need the owner's login.
The card checks every reply against this contract (`readDocShare*` in
`src/protocol.ts`): a reply without `host_matches` counts as `null`, every way
in must be one printable line (the endpoint HTTPS), and a claim link an HTTPS
page with the claim secret in its fragment.

## Document assistants

The control card's **文档助手** tab lets every signed-in member of the tenant
start their own Claude agent for this document. It runs on the owner's device
as the owner's session (the owner's Claude quota), may read the card's linked
project — one registered workspace, never Home, read-only — and reads, or also
writes, this document as the Octopus app (`assistant.rights`). Each person
sees their own assistants; the owner sees everyone's.

| Who | Sees | Can do |
|---|---|---|
| The card's owner | the setup while assistants are off; then a summary (可读项目「…」（只读）· 可读写/只读本文档 · 使用 Claude), every assistant with whom it works for | turn assistants on with a project and rights (读写 by default), change them, or **关闭文档助手** (asks first; ends every live assistant); start, open, talk to and end any assistant |
| A signed-in tenant reader | the summary and their own assistants: title, 启动中/就绪/失败/已结束, when, 已固定 | **新对话**: start one; **打开**, talk, **固定到文档**, **结束** (asks first) |
| Anyone not signed in to Feishu, or outside the tenant | that assistants need a sign-in in this organisation | go to 访问密钥 instead |
| Any reader, once its guest pinned it | the assistant as an ordinary live card in the document | watch it; only its guest and the owner talk to it |

Only the owner learns which device and workspace the project is: anyone else
gets its label alone, which is all the summary shows. A bridge from before
assistants answers no `assistant`, read as off; its owner is told there is
nothing to turn on yet rather than shown the setup.

**Turning them on** (the owner). The setup lists the owner's devices and their
registered workspaces (`assistant-targets`); a device that cannot run
assistants is listed, disabled, with its reason. Before **开启** it says
plainly what it means: 开启后，能打开这篇文档的组织成员都能启动自己的助手：它能读取所选项目里的全部文件（包括配置和日志），并以
Octopus 应用身份读写这篇文档；助手使用你的 Claude 额度. **设置** later changes the
project or rights; **关闭文档助手** (`rights: null`) ends every live assistant.
The bridge's limits (`limits.per_card` live per card, `per_guest` live per
person, `per_guest_per_day` starts per person per 24 h) are stated there and
in the new-conversation form; refusals are shown as the bridge words them.

**Starting one.** **新对话** opens a box: 让助手做什么？ and the name it will
call the reader by (their Feishu name, editable; at most 40 characters).
⌘/Ctrl+Enter or **启动助手** calls `assistant-start` with a fresh request id
(kept for a retry of the same task, so a repeat joins the first start). The
panel then asks `assistant-status` every 2 s while the assistant is starting
— never while the document is hidden or the card scrolled away — and opens
its conversation once it is ready; a failed start says why.

**The conversation.** A ready assistant's status carries the card capability
of its session (`binding`, a `ds_` share). The panel holds it in memory only
— nothing is written to the document's Record — and shows the same
conversation as an Agent card over it: transcript, status, composer, stop;
never fork. ← returns to the list. **固定到文档** (its guest only)
inserts it right below the control card as an ordinary Agent card; **结束**
ends it. On the inline surface a conversation takes the whole body, the
composer at the bottom.

**Pinned assistants.** An Agent card whose frame carries `assistant` is
labelled 「文档助手 · 为 <guest> 工作」. Its composer shows only when the bridge
says the reader may talk (`canTalk`: the guest, even without an Octopus
account, and the owner); everyone else watches. It has no card menu: no
fork, snapshot, speakers, workspace sharing, change of session or removal
here, and mentioned files stay plain text.

Bridge calls, always with the `fda_` bearer (an assistant call never goes out
without a login): `POST assistant-targets {}`, `assistant-configure {anchor,
rights, device?, workspace_id?}`, `assistant-list {anchor}`, `assistant-start
{anchor, host_token, task, request_id, name}`, `assistant-status {id}`,
`assistant-end {id}`, `assistant-pin {id}`. Every reply is checked
(`readAssistant*` in `src/protocol.ts`); a status's `binding` must name a
Claude card capability exactly as a card Record would. The list is read only
once the tab is in front, so a reader who stays on the keys is never asked to
sign in for it.

## Trust model

- **Observation is the owner's explicit, revocable decision.** Placing a session
  mints a random capability (`ds_` + 32 bytes). The card keeps it in its
  document Record, so "who may watch" is exactly "who can read this card" —
  intersected with the tenant check below. The server stores only its SHA-256
  (`feishu_docs_shares`, migration 87) and serves it only while not revoked.
- **The session id is not a secret.** Session Hub resource ids are reversible
  encodings of owner/device/session; nothing in this design treats one as
  authority.
- **Every caller is a verified tenant member.** The bridge exchanges the SDK's
  one-time login code with Feishu (`mina/v2/tokenLoginValidate`), requires the
  configured `tenant_key`, and issues a memory-only `fda_` bearer bound to the
  exact iframe origin (15 min idle, 30 min absolute). The Feishu tokens that
  come back are discarded. Members without an Octopus account get an
  observer-only login; nothing is registered.
- **Reads run on the owner's behalf, narrowed to one session.** As with a dev
  ticket's read-only transcript lease, owner and device come from the stored
  row, never from the caller. Viewers receive conversation text and tool
  *names* only — never thinking, tool inputs or tool outputs.
- **Input never rides on the capability.** `send` and `stop` require the
  caller's own login to be the share's owner and go through the durable
  operation coordinator (`append_session` / `interrupt_session`) with a
  request id, so a repeated request joins the first instead of starting a
  second turn. The card never receives the Dashboard's browser-only silent
  execution exception.
- **Only this route family has CORS**, with exact origins and no cookies.
  Capabilities travel in POST bodies, never URLs. Dashboard cookies and admin
  bearers confer nothing here.
- **Agents place cards as the owner.** `feishu_doc_place` mints the same share
  the picker would and inserts an add-on block through the Feishu OpenAPI with
  the owner's stored OAuth user token (never leaving the bot); Feishu decides
  whether the owner may edit the document. A failed insert revokes the share.
  The Record names the document both ways (`doc` = docx id, `alias` = wiki
  token), so the copy guard accepts whichever the host reports.
- **A mentioned path is a name; a workspace grant is the authority.** The
  bridge maps the name to one of the owner's registered workspaces using facts
  the owner's Runner reports (each session's directory inside its workspace, the
  session's absolute cwd), checks `workspace_grants` (migration 88) for anyone
  but the owner, and reads with read-only rights on the owner's Workspace Files
  root. The Runner confines every read to the workspace's real path, so a wrong
  mapping can only fail to open. Files over 8 MB are not served; the response
  is an inert download (`application/octet-stream`, metadata in
  `x-octopus-file`) that the card turns into a Blob.
- **A board renders as static content, whatever its HTML says.** Boards live
  in `feishu_docs_boards` (migration 89): the agent updates one by its `bd_`
  id; the card's Record holds a separate `db_` capability, stored only as its
  SHA-256, which any signed-in tenant reader may use to read the board and only
  the owner may revoke. The server refuses `<script>` so the agent learns
  why. The card parses the HTML inertly and rebuilds it from an allowlist into
  a shadow root (`src/board-html.ts`): no scripts, frames, forms, SMIL or event
  handlers survive; links keep http(s)/mailto targets and open through the
  host; images and CSS `url()` keep only inline `data:image` and `#fragment`
  references, so reading a board never tells a third party who is reading.
  Styles are applied through the CSSOM, so a board renders the same under any
  host Content-Security-Policy and its CSS stays inside its shadow root.
- **No approvals, owner notices instead.** Placing, removing, starting agents
  and changing grants run without approval clicks; `docs-notify.ts` sends the
  owner one short Feishu card per event (repeated views and file opens are
  coalesced). Delivery failure never blocks an action.

## Cost model

All viewers of one card share one server-side tail: Session Hub `liveGrant`
plus `openRunnerTail`, the primitives behind the Dashboard's live transcript.
That is one Context and one audit row per watched card, at most one pinned
device read per 1.5 s, closed after 60 s without a viewer, 64 watched cards at
most. The card asks for frames every 2 s while the Agent works and every 6 s
while it idles, sends its revision and last row index, and receives either a
30-byte "unchanged" or only the rows it lacks. It stops asking while the
document tab is hidden or the card is scrolled out of view, and caches CORS
preflights for two hours.

A failed read drops its read path and resolves a fresh one after a backoff
(2 s doubling to 60 s): Session Hub may have served a bot-host fallback while
the device was offline, and that path must not outlive the outage. If the
owner's grants ever require a human approval to read, the watch stops at the
first such answer instead of raising more approvals.

## Code map

| File | Role |
|---|---|
| `src/host.ts` | the only module touching the official SDK: Record, permission, viewport, theme, modal/FloatCard, links, the inline card's height, the reader's name |
| `src/api.ts` | bridge client: one silent re-login on 401; a share card's reader who cannot sign in calls without a bearer |
| `src/Card.tsx` | card state: sign-in, owner/viewer/copied/removed states, the menu; assistant cards' limits |
| `src/Conversation.tsx` | a live conversation over a card capability: frame polling (`useLive`) and the composer, for a card's Record or an assistant held in memory |
| `src/Feed.tsx`, `src/Picker.tsx`, `src/ui.tsx` | transcript, session picker, shared pieces and safe Markdown |
| `src/protocol.ts` | wire types shared with the bridge; carries no authority |
| `../bot/src/feishu/docs-addon-auth.ts` | Feishu identity → tenant member / Octopus account |
| `src/FileViewer.tsx`, `src/pdf.tsx`, `src/paths.ts` | file/folder preview; PDF.js on demand; which paths are clickable |
| `src/WorkspacePanel.tsx`, `src/NewAgent.tsx` | workspace grants; starting a new agent |
| `../bot/src/feishu/docs-addon.ts` | shares, the shared tail, owner operations, place / launch / files |
| `../bot/src/feishu/docs-openapi.ts` | Feishu document calls as the owner |
| `../bot/src/feishu/docs-files.ts`, `docs-launch.ts`, `docs-notify.ts` | workspace mapping and reads; `start_session`; owner notices |
| `../bot/src/dashboard/routes/feishu-docs-addon.ts` | pre-parser origin/bearer gate and handlers |
| `src/BoardCard.tsx`, `src/board-html.ts` | board cards: version polling, owner controls; the allowlist renderer |
| `src/SharePanel.tsx`, `src/share-state.ts` | document-share cards: the two tabs and the frame; the keys, taking one, its one-time ways in, the owner's settings and claim link; the reducer for key actions and card-wide tasks (pending → confirmed / refused) |
| `src/Assistants.tsx` | the 文档助手 tab: the owner's setup, the list, starting one, its conversation |

## Developing

```sh
pnpm --filter @claude-bot/feishu-docs-addon preview:fixture   # http://127.0.0.1:5187
pnpm --filter @claude-bot/feishu-docs-addon typecheck
npx vitest run --project feishu-docs-addon --maxWorkers=1
npx vitest run --project node --maxWorkers=1 packages/bot/src/feishu packages/bot/src/dashboard/feishu-docs-addon-route.test.ts
```

The fixture is clearly labelled and never signs in or runs an Agent. Pick a
scene with URL parameters: `?role=owner|viewer|guest`,
`?scene=live|empty|copied|revoked|readonly|nogrant|home|board`, `?theme=dark`,
`?file=results/table2.csv` (open a mentioned file at start); `/modal.html` and
`/float.html` render the other two surfaces. Document-share cards:
`?scene=share-owner|share-viewer|share-anonymous|share-empty|share-many|share-secret|share-copied|share-unknown|share-invalid|share-revealed`
(`share-owner` holds a pending key whose ways in can be revealed;
`share-viewer` is a signed-in reader with a key of their own;
`share-anonymous` a reader who cannot sign in; `share-many` enough keys to
scroll; `share-secret` opens with a key just taken, its one-time box on
screen; `share-revealed` finds the pending key's command already taken). The
card's actions round-trip through an in-memory bridge with placeholder tokens.
`&self_serve=off|read|write` sets the owner's level (default `write`),
`&app_access=edit|view|none|unknown` the app's access (`view`/`none` raise the
banner), `&invite=1` gives the owner a claim link already, and
`&fail=network|action|take` makes the read, the next owner or key action, or
taking a key fail. `&host_matches=true|false|null` overrides the bridge's match
of the host token (by default it compares, so `share-copied` is `false`);
`&card_state=present|missing|unknown` sets its last check (a `missing` card is
found again on the next read). Document assistants:
`?scene=assistant-off|assistant-on|assistant-setup|assistant-starting|assistant-chat|assistant-failed|assistant-anonymous`
(off: the owner's setup, or with `&role=viewer` a reader's note; on: the list,
the owner seeing every guest's; setup: the owner's settings open; starting: a
reader starts one, which is ready 5 s later and opens; chat: a conversation
open; failed: a start that fails; anonymous: a reader who cannot sign in), and
`?scene=assistant-pinned` an assistant pinned into the document (`&role=guest`
is its guest, `viewer` a watcher). `&assistant_rights=read` makes them
read-only. The inline page plays Feishu desktop, where the card fills its
block (size the browser window to try heights); `&mobile=1` plays a mobile
client, where the card's height hint resizes the page.

## Packaging and publishing

```sh
FEISHU_APP_ID=cli_… FEISHU_BLOCK_TYPE_ID=blk_… VITE_OCTOPUS_DOCS_API=https://… \
  pnpm --filter @claude-bot/feishu-docs-addon package
```

`dist` holds the offline-web layout (`project.config.json`, `index.json`, three
HTML entries: inline `index`, `modal`, `float`). Upload it with the official
`opdev upload`, select the new widget version in the developer console, then
create and publish an app version. Uploading or saving a draft publishes
nothing. Fixture mode cannot be packaged.

One widget (one `blk_…`) serves every card kind; the block's Record key picks
the view: `octopusAgent` an Agent card, `octopusBoard` a board,
`octopusShare` a document-share card. All kinds share `index.json`'s initial
height (560px; readers resize); every card fills its block (a share card
hints its own height to Feishu mobile only). Publish a
widget version that contains the share card before the bridge places
`octopusShare` blocks: an older version does not know the key and shows such a
block as an empty Agent card, offering editors the session picker. A widget
with self-serve keys refuses a panel without their fields (`readDocSharePanel`
wants `via`, `mine`, `self_serve`, `app_access`, `invite`, `limits`), while an
older widget ignores them: deploy the bridge first.

The bridge is off unless `feishu_docs_addon` is configured with the tenant's
`tenant_key` and the exact published iframe origin(s) (observed, never guessed
or wildcarded). `block_type_id` (the widget's `blk_…`) enables
`feishu_doc_place`. Owner notices are sent by the same Feishu app, which needs
its bot capability and `im:message:send_as_bot`. The developer console needs the user scopes
`docx:document`/`docx:document:readonly` and the bridge origin in its
server-domain allowlist. Current production values and the release record live
in the ops notes, not here.

Rollback: disable `feishu_docs_addon` (or publish the previous widget version)
and deploy normally. Share rows stay inert; removing them is never required.
