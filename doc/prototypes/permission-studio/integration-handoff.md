# Permission Studio · integration handoff

## Product intent to preserve

The integrated surface should let a person answer, without knowing implementation terminology:

> Which resources I registered are held by which user, App, agent, organization, or workspace; for which action; with what confirmation mode; inherited from where; for which audience; and why would one exact action allow, ask, deny, or hit a hard block?

Keep the visible model to **Authority**, **Domain / Audience**, and **Permit**. Missing permission is ordinary deny. AUTO/ASK qualify a permit. BLOCK is reserved for rare hard prohibitions. Any cross-domain result must be an explicit publish, link, or copy product.

## User-visible states

| State | Required visible behavior |
|---|---|
| First use / no resources | Explain the App installation ceiling; allow independent modes per action; show a meaningful empty state after it. |
| Normal | Show registered resources and holder permits; select one decision; EXPLAIN it; optionally edit if the actor has authority. |
| Dense | Preserve resource/holder comparison, sticky orientation on wide screens, and a scannable permit list on narrow screens. |
| Saving pending | Disable duplicate submission, retain the draft locally, identify what is saving, and provide safe navigation behavior. |
| Refused | Keep every draft choice, name the authority or ceiling conflict, focus the offending action, and enable retry after correction. |
| Read-only audit | Preserve map, filters, explanation, and history; remove any implication that the viewer can edit. |
| Revoked terminal | Treat the App as holding no current permission; expire pending confirmations; retain read-only audit evidence. |

## Actor-specific entry points

### Personal owner

- Scope: resources the user registered.
- Primary question: who can act on them and with which confirmation mode?
- Main actions: EXPLAIN, edit a direct permit, lower an App installation ceiling, revoke.
- Must not imply authority over ACME-managed resources.

### Organization resource steward

- Scope: ACME-managed resources and mandatory rules.
- Primary question: do requested actions stay inside organizational authority and audience?
- Main actions: review/decide exceptions, explain denials, change mandatory rules when authorized.
- Must distinguish an organization deny from an absent personal permit.

### Workspace administrator

- Scope: Q3 Strategy members, workspace-held permits, cross-domain artifacts, and history policy.
- Primary question: what do current and future members see, and is the result a snapshot, live read-only view, or editable copy?
- Main actions: set history audience, create/revoke links, request or create copies where permitted.
- Must not silently broaden audiences when membership changes.

### Audit viewer

- Scope: immutable decision and change evidence allowed by their audit role.
- Primary question: why did an exact action reach this result at that time?
- Main actions: EXPLAIN and inspect history only.

## Data the UI needs

### Registered resource summary

- Stable resource reference and human label.
- Resource kind (document, directory, tool, credential handle).
- Registering owner/steward.
- Deciding authority and whether it is mandatory.
- Current domain.
- Allowed audience descriptions suitable for people, including workspace membership semantics.
- Whether the resource is active, revoked, or unavailable.

Never return secret material for a credential handle. The surface needs only its safe label and permitted actions.

### Permit row

- Holder label and holder kind: user, App, agent, organization, or workspace.
- Resource reference.
- Independent action.
- Current result/mode: AUTO, ASK, DENY, or rare BLOCK.
- Direct authority source or inherited workspace/organization source.
- Target audience.
- Effective start/end or revoked state when relevant.
- App installation ceiling for the action, expressed as a comparable mode.
- A safe, human-readable reason when a rule cannot be edited.

### Explanation

For one holder + resource + action + audience, return an ordered explanation that can be rendered as:

1. deciding authority;
2. domain/audience fit and any required publish/link/copy boundary;
3. permit lookup, mode, direct/inherited source, installation-ceiling comparison, and final result.

The UI should receive the final result and the evaluated facts together so it cannot accidentally display an invented allow state. Explanation text should be safe for display and must not reproduce arbitrary shared content.

### Workspace history policy

- Whether future members receive no history, links to live read-only history, or another explicitly approved product choice.
- Which resources and time range are covered.
- Who set the policy and which authority allowed it.
- What happens when a member leaves.
- Whether existing snapshots/copies remain after a policy change.

### Cross-domain product

- Product type: shared snapshot, live read-only view, or editable work copy.
- Boundary operation: publish, link, or copy.
- Source resource and source authority label.
- New authority where a copy creates one.
- Exact audience and membership behavior.
- Read/update mode, revocation behavior, freshness, and creation status.

## Proposed user actions

Names below describe product intent, not transport or framework contracts.

- Load the resources and effective permits visible to the current actor.
- Explain one proposed action for one audience without executing it.
- Load change history for one permit or resource.
- Save a direct permit draft, with an idempotency key so duplicate clicks cannot create duplicate changes.
- Correct and retry a refused draft without clearing unrelated fields.
- Set or lower the Expense Helper installation ceiling action by action.
- Revoke the App ceiling and invalidate pending ASK decisions.
- Propose, approve, or refuse an ACME organization exception.
- Set Q3 Strategy’s future-member history policy.
- Create/revoke a live read-only link.
- Publish a snapshot.
- Copy an editable work version into a target workspace.

Every modifying action should return one of: accepted and pending, applied, refused with a structured reason, or terminal/revoked. The interface must not infer success from a submitted request.

## Draft and concurrency behavior

- Give each editor session a draft identifier and each save attempt an idempotency key.
- Disable Save from first submit until an outcome arrives.
- Keep draft values client-side through pending and refusal.
- On conflict, return the changed authority/permit facts and let the user compare before retrying.
- A refusal should identify the exact action and reason category: mandatory authority, installation ceiling, audience boundary, revoked resource, or stale version.
- Closing during pending should not trigger another save. Returning should show the same pending operation or its final result.

## Safety and trust requirements

- Treat names and content from shared resources as untrusted display data; render as text, never executable markup.
- Do not send shared content into an explanation when stable resource/action metadata is enough.
- AUTO removes per-action confirmation only. It does not certify content, correctness, or App behavior.
- Keep `delete`, `send`, `pay`, `publish`, `execute`, `manage_access`, and `use_credential` independently governed even if create/update share a similar UI.
- Never expose credential values; show only a safe handle label.
- Destructive or external-effect actions need explicit result states and must never be simulated as successful by optimistic UI.
- Log the deciding authority, audience, direct/inherited source, and installation ceiling used for each consequential decision.

## Responsive and accessibility acceptance

- At 390px, replace the wide matrix with a resource/holder permit list; do not force horizontal reading of the whole table.
- Keep the EXPLAIN result adjacent to the selected item and keep the editor usable full-width.
- Provide visible keyboard focus for every interactive row/cell and control.
- Implement a production modal focus trap, Escape close, focus restoration, accessible names, status announcements, and error focus.
- Do not rely on color alone for permission modes or final decisions.
- In dense mode, preserve row/column orientation with sticky headers and useful accessible cell names.

## Open product questions

1. Does workspace history ever create editable copies automatically, or only live read-only links?
2. Are pending ASK requests cancelled immediately when an App ceiling is lowered below them?
3. Can an ACME steward delegate a bounded part of mandatory authority to Q3 Strategy administrators?
4. What provenance remains visible to Mei after receiving a snapshot copy?
5. When workspace membership ends, should existing editable copies survive under the copy’s new authority?

These choices materially affect audience semantics and should be settled before binding the prototype to production behavior.

## Review path (5–10 minutes)

1. Open `index.html`; leave Alice / normal / wide selected.
2. Select several matrix cells, including a blank action via the EXPLAIN builder, and verify allow/ask/deny reasoning.
3. Switch among owner, steward, workspace administrator, and auditor. Confirm the decision framing and edit rights change materially.
4. Switch to first use and inspect each independent installation-ceiling action.
5. Switch to pending and refused; confirm duplicate prevention and preserved draft messaging in the editor.
6. Switch to read-only and revoked terminal; confirm no editable path is implied.
7. Switch to 390px and repeat cell selection, EXPLAIN, and editor use with keyboard focus.

## Integration completion criteria

Integration is complete only when the UI renders effective results from authoritative responses, mutations expose pending/refused/applied outcomes, and automated tests cover actor differences, dense/narrow layouts, keyboard focus, refusal draft preservation, duplicate-submit prevention, revoked terminal behavior, and the full independent action set.
