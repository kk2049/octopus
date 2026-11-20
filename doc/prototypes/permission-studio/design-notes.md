# Permission Studio · C0 design notes

## Result

This clean-room prototype makes the everyday permission model inspectable as three product concepts: **Authority**, **Domain / Audience**, and **Permit**. The primary surface is a resource-by-holder permission matrix, not a generic dashboard. A selected cell becomes a concrete action decision with an `EXPLAIN` trace, and editing stays subordinate to understanding.

All names and records are fixtures: Alice, ACME, Q3 Strategy, Expense Helper, Mei, `report/42`, `expenses`, `calendar`, and a GitHub credential handle. There are no real credentials, customer records, network requests, or persistence.

## Information hierarchy

1. **Actor-specific decision strip** — says who the current operator is, the question they are responsible for, and the next decision.
2. **Resource permission map** — rows are registered resources; columns are user, app, agent, org, and workspace holders. Each populated cell shows action and confirmation mode. An empty cell means ordinary deny.
3. **Selected-decision detail** — names one holder, resource, action, audience, result, deciding authority, inheritance source, and install-ceiling check.
4. **EXPLAIN builder** — lets a reviewer ask about an arbitrary fixture action without implying execution.
5. **Cross-domain products** — separates shared snapshot, live read-only view, and editable work copy using only publish/link/copy semantics.
6. **Rule editor** — edits independent action modes and audience/source, while visibly locking mandatory organization rules.

## Interaction decisions

### The matrix is the home surface

Users first need to answer “which registered resources are held by whom, for which actions?” A tabular map preserves comparison and scanability better than a node graph. It also gives absence a precise meaning: no permit, therefore deny.

Cells deliberately contain compact action/mode pairs such as `create ASK`. Selecting a cell does not itself change anything; it focuses the explanation panel.

### EXPLAIN is concrete and procedural

Every explanation is phrased as one actor acting on one resource for one audience. The trace uses three steps:

1. Which authority may decide for the resource.
2. Whether the domain/audience boundary is unchanged or an explicit publish/link/copy product is required.
3. Whether a permit exists, its AUTO/ASK property, its direct or inherited source, and whether the App installation ceiling admits it.

Ordinary missing permission is `DENY`. `BLOCK` appears only on the credential handle’s `execute` fixture as a rare hard stop. AUTO and ASK are displayed as properties of an existing permit, not alternative grant types.

### Actor views are materially different jobs

- **Personal owner:** follows resources Alice registered and decides which App action needs confirmation.
- **Organization resource steward:** starts from ACME mandatory authority and reviews exceptions that personal/workspace rules cannot loosen.
- **Workspace administrator:** starts from membership audiences, the historical-content policy, and the choice among snapshot, live read-only, and editable copy.
- **Audit viewer:** starts from a why question, gets explanations and history, and cannot edit.

The prototype keeps one shared map so actors can communicate, but changes the decision framing, selected example, counts, scope, and editability. It does not merely hide the same button set.

### Installation sets a long-term ceiling

The first-run fixture asks Alice to choose a maximum mode independently for every action. Same-domain `read` may default to AUTO. `create` and `update` are independent. `delete`, `send`, `pay`, `publish`, `execute`, `manage_access`, and `use_credential` remain separately reviewable. The screen states that ACME-managed resources are still decided by organization authority.

### Save, refusal, and terminal states are explicit

- **Pending:** the primary save is disabled and labeled “正在保存”; a second submission cannot be made.
- **Refused:** the edited values remain visible, the reason identifies the authority conflict, and retry is adjacent. The retry demonstration refuses again until the fixture is conceptually corrected.
- **Read-only:** explanation remains available while edit is disabled.
- **Revoked terminal:** the App’s ceiling and pending confirmations are described as invalid; audit history remains available.

The normal save animation explicitly says it is a prototype and does not claim real authorization or persistence.

### Risk is visible but not alarmist

The editor warns that shared data can contain prompt injection and that AUTO does not make content trustworthy. It also says Expense Helper may make subtle mistakes. The warning sits near the choice that increases autonomy rather than being buried in help text.

## Responsive behavior

The fixture bar can force a 390px canvas. On narrow layouts:

- the wide comparison table becomes a vertical list of populated holder/resource permits;
- the selected explanation stacks directly after the list;
- the EXPLAIN builder becomes a two-column form with a full-width action button;
- cross-domain products become a single column;
- first-run action mode controls stack without horizontal scrolling;
- the rule editor becomes full width.

The real browser-width media query applies the same transformation below 640px. Wide mode retains sticky resource and header cells for dense scanning.

## Keyboard and accessibility behavior

- All interactive matrix cells and narrow-list rows are native buttons.
- Every control has a visible `:focus-visible` ring with a 3px high-contrast outline.
- The editor uses dialog semantics, moves focus to Close on open, returns focus to the opener on close, and supports Escape.
- State banners and toasts use status semantics.
- Matrix cells expose resource, holder, action, and mode in their accessible names.
- Color is reinforced by explicit AUTO/ASK/DENY/BLOCK text.

Focus trapping inside the dialog is intentionally omitted from this inert C0; integration should add a complete modal focus trap.

## Fixture/state controls

The dark prototype bar switches:

- roles: personal owner, organization steward, workspace administrator, audit viewer;
- states: first/empty, normal, dense, pending, refused-with-preserved-edit, read-only, revoked terminal;
- viewport: wide and 390px.

These controls are review scaffolding, not intended product chrome.

## Deliberately omitted

- Real sign-in, authority verification, authorization, persistence, networking, install, publish, link, copy, revoke, or audit export.
- Real prompts or shared content; fixtures only name resources.
- Bulk editing, search syntax, pagination, date filtering, notifications, policy import/export, and organization provisioning.
- A graph visualization; the permission relationships are more legible as a matrix plus a procedural explanation.
- Backend-shaped identifiers or transport structures.

## Open product decisions

1. When workspace history is enabled, does it include live read-only links only, or may it automatically create editable copies?
2. Can a user lower an App’s installation ceiling while active ASK requests are pending, and if so are those requests cancelled immediately?
3. Should an organization steward be able to delegate a bounded subset of mandatory authority to workspace administrators?
4. For a shared snapshot, should the recipient see the original authority and source domain after the copy is created?

## C0 self-review

**Verdict: PASS, with one bounded accessibility gap for integration.**

| Gate | Verdict | Evidence / gap |
|---|---|---|
| Primary actor, decision, next action | PASS | The role strip states all three, and each role opens on a relevant selected decision. |
| Actor differences | PASS | Owner, steward, workspace admin, and auditor have different jobs, framing, default decisions, scope, and editing rights. |
| Pending, refusal, terminal | PASS | Duplicate save is disabled; refusal preserves edits with retry; read-only and revoked terminal are explicit. |
| 390px and keyboard focus | PASS* | Dedicated narrow list and stacked layouts are provided; native controls and visible focus are present. *Full modal focus trapping remains an integration task. |
| Does not fake permission | PASS | Every mutation is labeled prototype-only; no network or persistence exists; EXPLAIN does not execute. |
| Product-shaped hierarchy | PASS | Resource matrix → concrete explanation → rule edit follows the product decision, not generic cards. |
