/**
 * Database migrations — versioned schema changes.
 */

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- Users
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        uid INTEGER NOT NULL UNIQUE,
        home_dir TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- User identity mappings (one user can have multiple external identities)
      CREATE TABLE IF NOT EXISTS user_identities (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        username TEXT NOT NULL REFERENCES users(username),
        PRIMARY KEY (provider, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(username);

      -- Session metadata
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        username TEXT NOT NULL REFERENCES users(username),
        config TEXT NOT NULL DEFAULT '{}',
        first_prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        total_turns INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0.0,
        workdir TEXT,
        parent_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);

      -- Conversation rounds
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        round_num INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        result TEXT NOT NULL DEFAULT '',
        turns INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rounds_session ON rounds(session_id);

      -- Channel bindings (restored on bot restart)
      CREATE TABLE IF NOT EXISTS channel_bindings (
        channel_type TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        username TEXT NOT NULL REFERENCES users(username),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        mode TEXT NOT NULL DEFAULT 'active',
        PRIMARY KEY (channel_type, channel_key, username)
      );

      -- User settings
      CREATE TABLE IF NOT EXISTS user_settings (
        username TEXT NOT NULL REFERENCES users(username),
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (username, key)
      );

      -- Group-level configuration
      CREATE TABLE IF NOT EXISTS group_config (
        channel_id TEXT PRIMARY KEY,
        system_prompt_file TEXT,
        enabled_plugins TEXT DEFAULT '[]',
        use_preset INTEGER DEFAULT 1,
        group_mode TEXT DEFAULT 'shared',
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Workspaces (project-level isolation)
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username),
        remote_name TEXT NOT NULL,
        workdir TEXT NOT NULL,
        feishu_chat_id TEXT,
        display_name TEXT,
        tunnel_port INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(username, remote_name, workdir)
      );
      CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(username);
      CREATE INDEX IF NOT EXISTS idx_workspaces_feishu ON workspaces(feishu_chat_id);

      -- Link sessions to workspaces
      ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      -- Projects (idea/research management)
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'inbox',
        phase TEXT NOT NULL DEFAULT 'scout',
        workspace_id TEXT,
        feishu_chat_id TEXT,
        active_session_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_username ON projects(username);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

      -- Project events (audit trail)
      CREATE TABLE IF NOT EXISTS project_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        agent_role TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events(project_id);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS kanban_boards (
        id TEXT PRIMARY KEY,
        chat_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        idea TEXT DEFAULT '',
        status TEXT DEFAULT '{}',
        logs TEXT DEFAULT '[]',
        pinned_msg_id TEXT,
        owner_username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_chat ON kanban_boards(chat_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_owner ON kanban_boards(owner_username);
    `,
  },
  {
    version: 5,
    sql: `ALTER TABLE kanban_boards ADD COLUMN remote_config TEXT DEFAULT '';`,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS cross_user_acl (
        asker_username TEXT NOT NULL REFERENCES users(username),
        target_username TEXT NOT NULL REFERENCES users(username),
        allowed_tools TEXT NOT NULL,
        require_approval INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (asker_username, target_username)
      );
      CREATE INDEX IF NOT EXISTS idx_cross_user_acl_asker ON cross_user_acl(asker_username);
      CREATE INDEX IF NOT EXISTS idx_cross_user_acl_target ON cross_user_acl(target_username);
    `,
  },
  {
    version: 7,
    sql: `
      -- Secretary-network report packages (secretary-to-secretary relayed reports)
      CREATE TABLE IF NOT EXISTS report_packages (
        id TEXT PRIMARY KEY,
        from_user TEXT NOT NULL REFERENCES users(username),
        to_user TEXT NOT NULL REFERENCES users(username),
        topic TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_points TEXT NOT NULL DEFAULT '[]',          -- JSON array of string
        decisions_needed TEXT NOT NULL DEFAULT '[]',    -- JSON array of string
        evidence TEXT NOT NULL DEFAULT '[]',            -- JSON array of Evidence
        reporter_judgment TEXT NOT NULL DEFAULT '',
        reformatted TEXT,                               -- JSON of boss-side reformat (null until received)
        status TEXT NOT NULL DEFAULT 'draft',           -- draft|delivered|received|rejected|cancelled|superseded
        origin_channel_id TEXT,                         -- reporter channel (for receipts)
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_report_from ON report_packages(from_user);
      CREATE INDEX IF NOT EXISTS idx_report_to ON report_packages(to_user);
      CREATE INDEX IF NOT EXISTS idx_report_status ON report_packages(status);
    `,
  },
  {
    version: 8,
    sql: `
      -- Laptop Runner device credentials (secretary network front-end heads).
      -- One row per (user, device); the token itself is never stored, only its
      -- sha256, so a DB leak does not leak connectable credentials.
      CREATE TABLE IF NOT EXISTS runner_tokens (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username),
        device TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        UNIQUE(username, device)
      );
      CREATE INDEX IF NOT EXISTS idx_runner_tokens_user ON runner_tokens(username);
    `,
  },
  {
    version: 9,
    sql: `
      -- Long-lived per-pair report alignment rooms (Feishu groups reused
      -- across reports between the same two users; user_a < user_b lexically).
      -- active_report_id/session_id describe the currently running alignment
      -- meeting (NULL = room idle).
      CREATE TABLE IF NOT EXISTS report_rooms (
        chat_id TEXT PRIMARY KEY,
        user_a TEXT NOT NULL REFERENCES users(username),
        user_b TEXT NOT NULL REFERENCES users(username),
        active_report_id TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_a, user_b)
      );
    `,
  },
  {
    version: 10,
    sql: `
      -- OpenAI-provider conversation state (stateless HTTP APIs need the
      -- full history replayed each call). One row per provider-side session
      -- id per path kind ('chat' | 'responses'); payload is the exact JSON
      -- the in-memory cache holds, system-prompt state included. Restart
      -- amnesia fix: sessions resume with their history AND persona intact.
      CREATE TABLE IF NOT EXISTS llm_conversations (
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, kind)
      );
    `,
  },
  {
    version: 11,
    sql: `
      -- Graceful-restart persistence (doc/design-lifecycle-persistence.md).

      -- Inbound messages that arrived while the bot was draining: queued
      -- with a receipt, replayed through the provider after restart.
      -- mentioned_bot preserves the original mention state so a replayed
      -- bystander message stays a bystander message.
      CREATE TABLE IF NOT EXISTS pending_inbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mentioned_bot INTEGER NOT NULL DEFAULT 1,
        received_at TEXT NOT NULL
      );

      -- Cross-user approval requests awaiting the target's card click. The
      -- asker's agent round already ended (non-blocking), so the full query
      -- is serializable and restorable — approval cards survive restarts.
      CREATE TABLE IF NOT EXISTS cross_user_pending (
        request_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Secretary drafting/reformat jobs in flight. A row that survives into
      -- the next boot means the process died mid-job: the sweep notifies the
      -- originating channel (the DB holds no half-drafts — /report is
      -- idempotent to retry) and deletes the row.
      CREATE TABLE IF NOT EXISTS secretary_jobs (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        kind TEXT NOT NULL,
        progress_channel_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL
      );

      -- Alignment-room bystander notes (skipped chit-chat waiting to be
      -- flushed into the meeting secretary's next visible turn).
      CREATE TABLE IF NOT EXISTS room_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_notes_channel ON room_notes(channel_id);
    `,
  },
  {
    version: 12,
    sql: `
      -- Personal dashboard login keys (dt_ tokens; sha256 stored, plaintext
      -- shown once). One per user — /dashboard re-mints and replaces, so a
      -- leaked link is revocable by just asking for a new one. The browser
      -- keeps the token in an HttpOnly cookie after /login.
      CREATE TABLE IF NOT EXISTS dashboard_tokens (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE REFERENCES users(username),
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `,
  },
  {
    version: 13,
    sql: `
      -- Self-hosting dev pipeline, phase 1 (doc/design-self-hosting.md):
      -- the shared, strictly serial ticket queue. Single-active is enforced
      -- by claimNextDevTicket's transaction (only the bot process writes
      -- these rows; SQLite can't express a "unique over constant" partial
      -- index to back it up declaratively).
      --
      -- dev_status: queued → speccing → spec_ready → developing → gating
      --   → gated; side exits: needs_human (gate attempts exhausted or
      --   hard error — still HOLDS the serial slot until a human requeues
      --   or cancels), cancelled.
      -- deploy_status: NULL until gated, then 'pending'; later phases add
      --   deploying/live_unverified/verified/reverted (trusted deployment),
      --   or app_live (an App-only ticket whose immutable release activated).
      CREATE TABLE IF NOT EXISTS dev_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        requester TEXT NOT NULL REFERENCES users(username),
        model TEXT NOT NULL DEFAULT 'opus',
        effort TEXT NOT NULL DEFAULT 'high',
        spec TEXT,
        dev_status TEXT NOT NULL DEFAULT 'queued',
        deploy_status TEXT,
        branch TEXT,
        commit_sha TEXT,
        session_id TEXT,
        worktree TEXT,
        parent_ticket_id INTEGER REFERENCES dev_tickets(id),
        gate_attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dev_tickets_status ON dev_tickets(dev_status);

      -- Ticket conversation inbox, shared by web and Feishu. delivered_turn
      -- NULL = still queued ("待送达" bubble); set when a resume turn
      -- flushes it into the dev agent's prompt.
      CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        author TEXT NOT NULL,
        via TEXT NOT NULL,
        body TEXT NOT NULL,
        delivered_turn INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
    `,
  },
  {
    version: 14,
    sql: `
      -- Self-hosting phase 2 (doc/design-self-hosting.md 上线流水线):
      -- deploy intents are the bot↔supervisor contract. The bot INSERTs
      -- 'requested' rows (after sending the rescue card) and records the
      -- liveness decision; the ring-0 supervisor (bash + sqlite3 CLI)
      -- claims them and walks: claimed → building → restarting →
      -- health_gate → confirm_wait → succeeded | rolled_back | failed.
      -- detail carries stage logs and the rollback reason
      -- (health_gate_failed | confirm_timeout | user_rollback).
      -- Single-active is enforced in createDeployIntent's transaction.
      CREATE TABLE IF NOT EXISTS deploy_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_sha TEXT NOT NULL,
        base_sha TEXT,
        triggered_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested',
        confirm_deadline TEXT,
        confirm_decision TEXT,     -- 'alive' | 'rollback'; NULL = undecided
        confirm_by TEXT,
        confirm_at TEXT,
        detail TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deploy_intents_status ON deploy_intents(status);

      -- Post-deploy verification tickets: generated by the bot when it sees
      -- a succeeded intent (notified=0 sweep). All checklist owners passing
      -- advances the stable watermark; failure stays manual (operator
      -- triggers a rollback deploy or a fix ticket).
      CREATE TABLE IF NOT EXISTS verify_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id INTEGER NOT NULL REFERENCES deploy_intents(id),
        target_sha TEXT NOT NULL,
        ticket_ids TEXT NOT NULL,      -- JSON number[]
        modules_touched TEXT NOT NULL, -- JSON string[]
        checklist TEXT NOT NULL,       -- JSON [{ticket_id,title,criteria}]
        assignees TEXT NOT NULL,       -- JSON string[]
        status TEXT NOT NULL DEFAULT 'open',  -- open → passed | failed
        resolved_by TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verify_tickets_status ON verify_tickets(status);
    `,
  },
  {
    version: 15,
    sql: `
      -- Ticket kinds + turn liveness (doc/design-self-hosting.md 两条道).
      --
      -- kind decides the agent's PERMISSION TO ASK:
      --   'simple'  — never asks; ambiguity is resolved by the agent itself
      --               and recorded in the spec's 「## 假设」 section, then it
      --               goes straight to implementation. Queue it and walk away.
      --   'complex' — may stop and ask ('## 待确认' in the spec, or the
      --               <<ASK-USER>> sentinel mid-development); claims the dev
      --               lane ahead of simple tickets.
      -- Existing rows default to 'complex': that is exactly the pre-v15
      -- behaviour (draft → wait for a human → develop).
      ALTER TABLE dev_tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'complex';

      -- Set immediately BEFORE a headless CLI turn is spawned, cleared when it
      -- returns. This is the authoritative "a turn is running right now"
      -- signal: the log-derived activity state can only ever guess, because a
      -- finished 'claude -p' writes nothing to say it finished. Always NULL
      -- after a restart (no turn survives the process), so the pipeline clears
      -- it on boot.
      ALTER TABLE dev_tickets ADD COLUMN turn_started_at TEXT;
    `,
  },
  {
    version: 16,
    sql: `
      -- The workbench secretary's chats (/hq right column, ticket #7).
      --
      -- Why SQLite and not the HQ directory: hq/ops.commit() runs 'git add -A'
      -- after every write, so a transcript living under <memoryDir>/hq would
      -- be committed into the project's own history repo — chat chatter is not
      -- research history, and the event log stays the single source of truth.
      --
      -- One row per chat, one per message. 'running_since' is set the moment a
      -- turn is spawned and cleared when it returns: the page polls instead of
      -- holding the request open (a high-thinking turn outlives a proxy), and
      -- a value left behind by a restart is stale by definition — the loader
      -- clears it on boot, exactly like dev_tickets.turn_started_at.
      CREATE TABLE IF NOT EXISTS hq_chats (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新对话',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        running_since TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_chats_user ON hq_chats(username, updated_at DESC);

      CREATE TABLE IF NOT EXISTS hq_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,          -- user | assistant | tool | error
        content TEXT NOT NULL,
        tool_name TEXT,              -- set when role = 'tool'
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hq_chat_messages ON hq_chat_messages(chat_id, id);
    `,
  },
  {
    version: 17,
    sql: `
      -- Short display name for the sidebar (ticket #8). The spec turn writes it
      -- from the agent's own '## 名字' section — the requester's original title
      -- is often a long paragraph and does not fit a 340px list. Nullable: the
      -- extractor may miss, and old rows carry NULL until backfill fills them.
      -- 'title' stays authoritative; 'slug' is a UI preference, not truth.
      ALTER TABLE dev_tickets ADD COLUMN slug TEXT;
    `,
  },
  {
    version: 18,
    sql: `
      -- Ticket #10: how the SENDER wants this report delivered.
      --   ''   → per config (secretary.group_delivery: auto pulls the pair's
      --          alignment group, else a private receipt card)
      --   'dm' → no three-way room: the receipt goes to the recipient's
      --          private chat, and acceptance binds a Q&A secretary session
      --          there (teaching/light-handoff scenarios need no reporter
      --          in the loop).
      -- A column (not a settings key) because the choice is PER REPORT and
      -- must survive alongside the package through its whole lifecycle.
      ALTER TABLE report_packages ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 19,
    sql: `
      -- Ticket #12: agent-native pipeline. The ten-value dev_status machine
      -- (queued/speccing/spec_ready/ready_to_dev/developing/gating/gated/
      -- awaiting_reply/needs_human/cancelled) collapses to three:
      --   'open'      — the conversation is alive; questions, errors and
      --                 approvals are MESSAGES now, not statuses
      --   'landed'    — gates passed and the branch fast-forwarded into the
      --                 base branch (old 'gated'); still accepts messages —
      --                 a follow-up chat can claim and land again
      --   'cancelled' — terminal
      -- Everything the old intermediate states encoded either moved into the
      -- conversation (asking, needing a human) or into the claim/submit tool
      -- pair's in-memory lock (which turn may mutate code). Old mid-flight
      -- rows map to 'open': their session survives, so the next message just
      -- resumes them.
      UPDATE dev_tickets SET dev_status = 'landed' WHERE dev_status = 'gated';
      UPDATE dev_tickets SET dev_status = 'open' WHERE dev_status NOT IN ('landed', 'cancelled');
    `,
  },
  {
    version: 20,
    sql: `
      -- Ticket #14: body-only ("redacted") report mode. The sender's
      -- secretary drafts a final report body from the material and only
      -- that body crosses the wire — no session archive, no evidence
      -- refs, no follow-up Q&A. The column is per-report (like
      -- delivery_mode) because the choice must survive alongside the
      -- package for its whole lifecycle.
      --   'full'      → today's flow (evidence + points + receiver-side
      --                 reformat, optional Q&A on the archive)
      --   'body_only' → sender-authored body ships alone; delivery = done
      ALTER TABLE report_packages ADD COLUMN mode TEXT NOT NULL DEFAULT 'full';
    `,
  },
  {
    version: 21,
    sql: `
      -- Ticket #15: capabilities you can hand out from the web.
      --
      -- Before this, "admin" was a single shared config key with no account
      -- behind it, and every logged-in personal key could see (and drive) the
      -- whole dev pipeline. Both halves are wrong for a multi-user host: the
      -- owner wants to BE an admin as themselves, and the dev system must be
      -- invisible until it is explicitly handed out.
      --
      -- Who is admin stays in config (dashboard.admins) — bootstrapping an
      -- admin from inside the panel would be a privilege-escalation door.
      -- Everything below admin is a row here, so it can be granted and
      -- revoked live at /admin:
      --   'dev'    → the dev tab, ticket list, ticket conversations
      --   'deploy' → trigger deploys, land branches, decide the rescue window
      --              (implies 'dev'; resolved in the identity, not stored)
      -- granted_by is the granting identity ('admin-key' for the shared key)
      -- so a grant is always attributable, same rule the report flow uses.
      CREATE TABLE IF NOT EXISTS user_grants (
        username TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (username, capability)
      );
    `,
  },
  {
    version: 22,
    sql: `
      -- Ticket #16: separate the moment a ticket LANDED (its branch entered
      -- the base branch) from every other 'updated_at' bump. The panel now
      -- sorts landed rows by this timestamp so the sidebar order matches
      -- \`git log\` — a ticket filed on Monday but merged on Friday sits
      -- with Friday's other landings, not with Monday's open work.
      -- NULL for open/cancelled rows and for rows that landed before this
      -- migration; the sort treats NULL landed_at as "sort with the opens".
      ALTER TABLE dev_tickets ADD COLUMN landed_at TEXT;
    `,
  },
  {
    version: 23,
    sql: `
      -- Server-side opaque web sessions.
      --
      -- Until now the browser cookie WAS the long-lived bearer token: stealing
      -- it stole the account until the token was re-minted, there was nothing
      -- to expire and nothing to revoke per device. That is tolerable for a
      -- read-only panel; it is not tolerable as the thing that proves "a human
      -- approved this exec on my laptop"
      -- (approval: doc/tcb-reading-guide.md §3).
      --
      -- So: /login exchanges the bearer for a fresh high-entropy session id.
      -- Only its hash is stored, alongside a per-session CSRF secret, an idle
      -- window and an absolute expiry. Approval endpoints accept ONLY this
      -- credential (plus CSRF + exact Origin) — a script holding the bearer
      -- can still read, but cannot claim to be a human pressing a button.
      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        absolute_expiry TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(username);
    `,
  },
  {
    version: 24,
    sql: `
      -- Persistent authorisation INTENT, and the activity record that explains it.
      --
      -- Until now "what may this app do" lived in \`v3_host.apps.*\` in
      -- config.yaml, and "what may the panel do on my behalf" was a boolean
      -- owner check at each route. Neither is something a user can see, narrow
      -- or take back, and neither survives the question "why does this still
      -- work?".
      --
      -- What this table is NOT: an execution decision. The capability kernel
      -- stays the only thing that authorises a call. A row here is the durable
      -- INTENT a person expressed; the kernel Context derived from it is the
      -- short-lived执行物. Deleting a row cannot reach into a running Context,
      -- which is why revocation is "mark the row, then tear the Contexts down"
      -- and never one without the other.
      --
      -- Additive-only, per the repo's migration rule: an older binary that has
      -- never heard of these tables still reads and writes every table it knows.
      -- It would simply behave as it did before — which for grants means the
      -- config-seeded defaults, not a wider permission.
      CREATE TABLE IF NOT EXISTS grant_intents (
        id TEXT PRIMARY KEY,
        -- 'service' (session-hub) | 'app' | 'agent'
        subject_type TEXT NOT NULL,
        -- 'session-hub' | '<app>' | '<app>/<agent>'
        subject_id TEXT NOT NULL,
        -- The ACCOUNT whose resources this reaches. A grant is always somebody's.
        owner TEXT NOT NULL,
        -- 'runner-account' (every registered device) | 'runner-device' (one)
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL DEFAULT '*',
        operations TEXT NOT NULL DEFAULT '[]',   -- JSON array of hub operation ids
        terms TEXT NOT NULL DEFAULT '{}',        -- JSON: { autoAllow: [...] }
        -- 'user' | 'admin' | 'config' | 'system-policy' | 'bootstrap'
        -- 'bootstrap' is deliberately its own value: importing today's implicit
        -- owner access must NOT be recorded as "the user clicked agree".
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',   -- active|revoked|expired|superseded
        contract_digest TEXT,
        publisher TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_by TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_grant_intents_owner ON grant_intents(owner, status);
      CREATE INDEX IF NOT EXISTS idx_grant_intents_subject ON grant_intents(subject_type, subject_id, owner);

      -- The activity record behind "why is this still valid" and "what did it
      -- actually do". One row per decision, written by the permission service
      -- and by the Session Hub; the kernel's own audit callback feeds it too.
      CREATE TABLE IF NOT EXISTS permission_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        owner TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        resource TEXT NOT NULL DEFAULT '',
        -- allow|deny|pending|approve|reject|result|revoke|grant|error
        decision TEXT NOT NULL,
        reason TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_permission_audit_owner ON permission_audit(owner, id DESC);
    `,
  },
  {
    version: 25,
    sql: `
      -- One CHAT SUBMISSION in the Session Hub, as a durable thing.
      --
      -- Until now a submission was an HTTP request: the browser learned
      -- "queued for approval" and then nothing, because the approval's result
      -- came back to whoever pressed the button rather than to the chat that
      -- asked. Four states that a user has to be able to tell apart —
      -- waiting for a human / running on the device / finished / cannot be
      -- proven — were carried by a socket that a page reload destroyed.
      --
      -- What is NOT here, deliberately:
      --   · the prompt. It is frozen inside the capability PendingCall (which
      --     is what an approval is bound to) and lands in the transcript. A
      --     second copy would be a second place to leak it from and a second
      --     thing to keep in step with what will actually run.
      --   · the transcript. \`detail\` is a short summary; the session file is
      --     the record of what happened.
      --
      -- \`args_hash\` is a SHA-256 fingerprint of the INTENT (operation + cli
      -- kind + prompt), the same shape the single-writer lease uses, so a
      -- double-clicked button joins the operation that already exists instead
      -- of starting a second turn.
      --
      -- \`context_id\` is the capability Context the call was made in. It is how
      -- a restarted process can still read the outcome of an approval that was
      -- decided while it was down (the kernel refuses \`resultOf\` for any other
      -- Context, so this is a lookup key and not authority).
      CREATE TABLE IF NOT EXISTS session_operations (
        -- A random operation id is an identifier, not a clock. Keep a private
        -- monotonic sequence for deterministic newest/oldest queries even when
        -- multiple rows share one millisecond.
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        -- The one-way handle of the credential that submitted it, so ending one
        -- browser login can be reflected in what that login started.
        credential TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        device TEXT NOT NULL,
        cli_kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        -- append_session | resume_session. Distinct authorisation and audit
        -- identity over one execution path; recorded as submitted, never
        -- defaulted after the fact.
        operation TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        pending_call_id TEXT,
        context_id TEXT,
        -- submitted|waiting_approval|running|succeeded|failed|rejected|unknown
        status TEXT NOT NULL,
        detail TEXT,
        -- Claude's resume forks a new session id; the viewer follows it.
        new_session_id TEXT,
        submitted_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_operations_owner
        ON session_operations(owner, sequence DESC);
      -- The dedupe lookup: live rows for one intent on one session.
      CREATE INDEX IF NOT EXISTS idx_session_operations_intent
        ON session_operations(owner, resource_id, args_hash, status);
      CREATE INDEX IF NOT EXISTS idx_session_operations_pending
        ON session_operations(pending_call_id);
    `,
  },
  {
    version: 26,
    sql: `
      -- The lifecycle state machine is shared by the direct Hub and isolated
      -- App surfaces. Authority is not shared: this discriminator prevents an
      -- identical intent on one surface from joining the other surface's row.
      ALTER TABLE session_operations ADD COLUMN surface TEXT NOT NULL DEFAULT 'hub';
      DROP INDEX IF EXISTS idx_session_operations_intent;
      CREATE INDEX idx_session_operations_intent
        ON session_operations(owner, surface, resource_id, args_hash, status);
    `,
  },
  {
    version: 27,
    sql: `
      -- Whether one account trusts one publisher's App code is deliberately a
      -- different record from what that App may do. Trust permits loading and
      -- disclosing data to a package; grant_intents remains the capability
      -- consent and the capability Gate remains the execution decision.
      CREATE TABLE IF NOT EXISTS app_trust (
        owner TEXT NOT NULL,
        app_id TEXT NOT NULL,
        publisher TEXT NOT NULL,
        profile TEXT NOT NULL CHECK(profile IN ('declarative', 'publisher-js')),
        package_digest_at_consent TEXT NOT NULL,
        follow_updates INTEGER NOT NULL DEFAULT 0 CHECK(follow_updates IN (0, 1)),
        decided_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (owner, app_id, publisher)
      );
      CREATE INDEX IF NOT EXISTS idx_app_trust_owner
        ON app_trust(owner, revoked_at);
    `,
  },
  {
    version: 28,
    sql: `
      -- Immutable Agentic App releases, and which one is active.
      --
      -- Until now a release was whatever the source tree happened to contain:
      -- Session Plus derived one identity at boot and memoised it, so "change
      -- the active release" and "restart the process" were the same act. These
      -- two tables make a release a thing that exists independently of the
      -- process that serves it.
      --
      -- What this is NOT, and must never become:
      --   · App trust. \`app_trust\` records whether an account trusts a
      --     publisher's code. A row here says a release EXISTS, which is not a
      --     decision anybody made about it.
      --   · Permission intent. \`grant_intents\` records what an app may ask
      --     for; \`permission_contract_digest\` here is a fact about the release
      --     (opaque to this layer, computed by the permission layer), not a
      --     grant.
      --   · Authorisation. The capability Gate remains the only thing that
      --     authorises a call.
      -- Uninstalling a release therefore marks THIS metadata and touches none
      -- of those tables, so a reinstall is auditable rather than amnesiac.
      --
      -- The primary key is the complete package digest, which is also what the
      -- View origin is derived from: one artifact, one identity, one row. The
      -- descriptor is stored as canonical JSON and re-validated on read — the
      -- catalog is trusted to be ours, not to be intact, and a row a running
      -- build cannot re-describe must fail closed rather than be served.
      --
      -- Additive-only, per the repo's migration rule: an older binary that has
      -- never heard of these tables reads and writes every table it knows and
      -- behaves exactly as it did.
      CREATE TABLE IF NOT EXISTS app_releases (
        package_digest TEXT PRIMARY KEY,
        stable_app_id TEXT NOT NULL,
        publisher TEXT NOT NULL,
        -- Same vocabulary as app_trust.profile: a profile change never
        -- inherits an old trust decision, so the two must not drift.
        execution_profile TEXT NOT NULL
          CHECK(execution_profile IN ('declarative', 'publisher-js')),
        permission_contract_digest TEXT NOT NULL,
        descriptor TEXT NOT NULL,
        -- How THIS deployment obtained the artifact. Not part of the digest:
        -- it is an installation fact, not a property of the bytes. There is no
        -- 'signed' value because no publisher signature is ever verified.
        provenance_kind TEXT NOT NULL
          CHECK(provenance_kind IN ('platform-built', 'external-attestation')),
        provenance TEXT NOT NULL,
        content_root TEXT NOT NULL,
        installed_by TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        -- Uninstall marks metadata; the immutable artifact is left as
        -- unreferenced content for an explicit, separate reclamation job.
        removed_by TEXT,
        removed_at TEXT,
        -- Lets the activation table bind all three identity fields with one
        -- foreign key, not merely assert that the digest exists somewhere.
        UNIQUE(package_digest, stable_app_id, publisher)
      );
      CREATE INDEX IF NOT EXISTS idx_app_releases_app
        ON app_releases(stable_app_id, publisher, installed_at DESC);

      -- The active pointer: at most one release per (app, publisher).
      --
      -- One row per app rather than an append-only history, because the thing
      -- that has to be atomic is "which release is live right now", and a
      -- pointer that is a single row cannot be observed half-moved. The
      -- foreign key means the pointer can never name a release this database
      -- does not have.
      CREATE TABLE IF NOT EXISTS app_release_activations (
        stable_app_id TEXT NOT NULL,
        publisher TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        activated_by TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        PRIMARY KEY (stable_app_id, publisher),
        FOREIGN KEY (package_digest, stable_app_id, publisher)
          REFERENCES app_releases(package_digest, stable_app_id, publisher)
      );
      CREATE INDEX IF NOT EXISTS idx_app_release_activations_digest
        ON app_release_activations(package_digest);
    `,
  },
  {
    version: 29,
    sql: `
      -- App agents: the execution traces, NOT the messages.
      --
      -- Three pieces of state, and the split between them is the whole design:
      --
      --   · inbox messages live in the App's own State stream, under the
      --     platform's reserved event type, because they must survive a
      --     restart, be ordered, and be idempotent — and that store already
      --     gives all three. They are NOT here.
      --   · the CURSOR (how far this agent has read) is here, because it is a
      --     consume-at-start execution mark rather than a domain fact. Putting
      --     it in the event log would publish "where the engine is" into the
      --     publisher's projection, and — because an append-only log can only
      --     ever grow — would turn one conversation's cursor into an unbounded
      --     chain of events.
      --   · the transcript is here for the same reason \`hq_chat_messages\` is:
      --     it needs tail reads and pruning, and an append-only log offers
      --     neither.
      --
      -- \`upto_seq\` is advanced in the SAME transaction that records the turn,
      -- before the model is called. A failed turn therefore does NOT replay its
      -- messages: the tool calls it already made are not undone by a retry, and
      -- a turn that fails deterministically would otherwise retry for ever. The
      -- price is written down rather than hidden — the transcript carries a note
      -- saying those messages will not come back.
      --
      -- Additive-only, per the repo's migration rule.
      CREATE TABLE IF NOT EXISTS app_agent_cursors (
        -- Stable app id, not the package digest: a release upgrade must not
        -- make an agent re-read its whole inbox.
        app_id TEXT NOT NULL,
        -- The State scope this agent runs in. \`account:<owner>\` today.
        scope_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        upto_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, scope_key, agent)
      );

      -- One row per turn. A turn is a thing with a lifetime, exactly like a
      -- session operation: 'running' -> 'succeeded' | 'failed' | 'unknown'.
      --
      -- 'unknown' is a TERMINAL state, not a to-do. A process that restarts
      -- mid-turn cannot know whether the tool calls it had already dispatched
      -- took effect, and neither optimism ("succeeded") nor a retry is honest:
      -- App actions are not idempotent. Same ruling as session_operations.
      CREATE TABLE IF NOT EXISTS app_agent_turns (
        -- Ordering never uses the random id.
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        app_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        owner TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('running', 'succeeded', 'failed', 'unknown')),
        -- What woke this turn up. 'approval' is the resumption after a human
        -- decided a pending call, which is the answer to "a turn cannot block
        -- on an approval" rather than a second kind of turn.
        trigger TEXT NOT NULL
          CHECK(trigger IN ('inbox', 'daily', 'manual', 'approval')),
        -- Inclusive inbox range this turn consumed, for evidence.
        from_seq INTEGER NOT NULL,
        upto_seq INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_agent_turns_agent
        ON app_agent_turns(app_id, scope_key, agent, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_app_agent_turns_status
        ON app_agent_turns(status);

      CREATE TABLE IF NOT EXISTS app_agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        -- user | assistant | tool | note | error
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_agent_messages_scope
        ON app_agent_messages(app_id, scope_key, agent, id);
    `,
  },
  {
    // Version 31, not 29/30: those were reserved while sibling branches landed
    // in parallel (29 became the app-agent tables above); the migration runner
    // applies anything newer than MAX(version), so a GAP is harmless while a
    // COLLISION is silently destructive — two rows numbered the same would
    // apply the first and skip the second forever.
    version: 31,
    sql: `
      -- Agentic Apps that exist because somebody said so, not because somebody
      -- compiled them in.
      --
      -- Until now, serving a second App meant editing a composition root: an
      -- adapter constant, a HostedApp, one more element in an array. This table
      -- is the last constant moved out — a row here plus an installed release is
      -- a whole App, so "add an App" is an insert and a call rather than an edit
      -- and a deploy. (Platform convergence plan, decision 2.)
      --
      -- What a row is NOT, and must never become:
      --   · An implementation. There is no module, port, provider, directory,
      --     command or URL here, and there must never be: a declaration that
      --     could name an implementation would be a declaration that could
      --     install one. What the App DOES arrives inside a release, covered by
      --     that release's package digest.
      --   · A permission. A declared App's permission contract is EMPTY and its
      --     adapter refuses any release that says otherwise. Binding a typed
      --     port stays platform code that a reviewer merged and a deployer
      --     deployed.
      --   · App trust, a grant, or an activation. Those remain app_trust,
      --     grant_intents and app_release_activations respectively. Declaring an
      --     App serves nothing until a release is installed AND activated.
      --
      -- app_id is the primary key and doubles as this App's durable-state
      -- directory name, so the grammar enforced above this table is the same one
      -- AppBackendRegistry.register applies. Disabling is a flag rather than a
      -- delete: the App's durable state and any installed releases outlive the
      -- row's enabled bit, and a delete would make "this App used to exist" a
      -- question nothing can answer.
      CREATE TABLE IF NOT EXISTS app_declarations (
        app_id TEXT PRIMARY KEY,
        publisher TEXT NOT NULL,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        declared_by TEXT NOT NULL,
        declared_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 32,
    sql: `
      -- Which Agentic App an 'app' ticket is about.
      --
      -- The third ticket kind (see devpipe/app-scopes.ts) trades reach for
      -- agility: its diff may only touch one App's packages, and in exchange its
      -- gate runs that App's vitest projects instead of the whole repository.
      -- Both halves need to know WHICH App, and neither may infer it — guessing
      -- from the diff would let a ticket widen its own path allowlist by
      -- touching a second App's files first.
      --
      -- Nullable, and null for every 'simple'/'complex' row: an app id on a
      -- ticket that is not an app ticket is a claim nothing reads, and the two
      -- would drift. The store clears it whenever the kind moves away from
      -- 'app', so "kind = 'app' iff app_id is set" is maintained by the one
      -- writer rather than by a CHECK that a future kind would have to fight.
      --
      -- Deliberately NOT a foreign key to app_declarations: Session Plus is
      -- compiled in and has no row there, and the set of ticketable Apps is a
      -- source-code table (which packages exist) rather than a runtime one
      -- (which Apps this host serves).
      --
      -- Additive-only, per the repo's migration rule.
      ALTER TABLE dev_tickets ADD COLUMN app_id TEXT;
    `,
  },
  {
    version: 33,
    sql: `
      -- One background run of the full suite over the watermark.
      --
      -- Landing stopped running tests on 2026-08-09 (post-submit model): the
      -- suite moved here, behind the merge, one run at a time. A row is what
      -- makes that honest rather than merely fast — without it "has anything
      -- tested this code?" has no answer, and the model degrades into "nobody
      -- tests anything".
      --
      -- \`sha\` is the watermark tip the run pinned, NOT a branch: the tip moves
      -- while the run works, and the whole point of batching is that a green
      -- says something about one exact commit.
      --
      -- \`from_sha\` is the previous green, so a red can name the batch it
      -- implicates (\`git log from_sha..sha\`) instead of one commit it cannot
      -- justify blaming.
      --
      -- \`status\` is running | green | red | aborted. \`aborted\` is written at
      -- STARTUP for any row still 'running': a process that died mid-suite
      -- proves nothing, and resuming it would report a result for bytes nobody
      -- measured. Same rule as session operations — never resume, say unknown.
      CREATE TABLE IF NOT EXISTS test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha TEXT NOT NULL,
        from_sha TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        log_tail TEXT,
        ticket_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status, id DESC);
    `,
  },
  {
    version: 34,
    sql: `
      -- The full suite is now owned by GitLab CI, not by the bot host. Keep the
      -- existing test_runs projection for the dashboard and repair workflow,
      -- but identify the provider run durably so polling is idempotent across
      -- bot restarts. Existing rows are explicitly local history.
      ALTER TABLE test_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE test_runs ADD COLUMN external_id TEXT;
      ALTER TABLE test_runs ADD COLUMN external_url TEXT;
      ALTER TABLE test_runs ADD COLUMN failure_reason TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_test_runs_external
        ON test_runs(provider, external_id) WHERE external_id IS NOT NULL;
    `,
  },
  {
    version: 35,
    sql: `
      -- Personal MCP access tokens (mcp_ prefix; sha256 stored, plaintext shown
      -- once at mint). Unlike dashboard_tokens this is deliberately MANY rows
      -- per user: an MCP token is handed to one agent client, so each client
      -- gets its own label, its own optional expiry, and its own revocation —
      -- revoking the token you pasted into one tool must not log the others out.
      --
      -- Revocation MARKS the row rather than deleting it: the row is the only
      -- durable record that a credential existed, and "when was this revoked"
      -- is a question an audit deserves an answer to. The identity path treats
      -- a marked or expired row exactly like an absent one.
      --
      -- What an mcp_ token may DO is not in this table. It resolves to an
      -- owner-scoped identity that reaches only the MCP endpoint; the operation
      -- set is governed by the permission centre (session-hub grants for
      -- session tools, the 'mcp' service subject for workspace/document tools).
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username),
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(username);
    `,
  },
  {
    version: 36,
    sql: `
      -- One row per App whose release SHOULD be republished but could not be,
      -- yet (ticket #61). The case it exists for: an ordinary ticket lands a
      -- change to an App's View, and the only tree that can be packed — the
      -- deployed run checkout — does not carry that commit until somebody
      -- deploys. The request is durable so the publication rides the next
      -- deploy instead of depending on a person remembering.
      --
      -- One row per app, replaced by the newest request: publishing is
      -- idempotent and always packs a whole tree, so two pending requests for
      -- one App are the same request. Cleared on success — an empty table
      -- means "nothing is owed", which is what lets an operator roll back on
      -- /apps without a boot sweep undoing them.
      CREATE TABLE IF NOT EXISTS app_release_pending (
        app_id TEXT PRIMARY KEY,
        commit_sha TEXT NOT NULL,
        ticket_id INTEGER,
        requested_by TEXT NOT NULL DEFAULT '',
        requested_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT ''
      );
    `,
  },
  {
    version: 37,
    sql: `
      -- Shared App instances (ADR 0007 P1). A "room" is deliberately NOT an
      -- entity with its own lifecycle machinery: it is one app-state stream
      -- whose scope key is a server-minted opaque instance key, plus this
      -- membership table the platform door consults. Who may open/act is
      -- answered here; what an action MEANS stays in the App's sandbox.
      CREATE TABLE IF NOT EXISTS app_shared_instances (
        app_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        creator TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY (app_id, instance_key)
      );
      CREATE TABLE IF NOT EXISTS app_shared_members (
        app_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (app_id, instance_key, username)
      );
      CREATE INDEX IF NOT EXISTS idx_app_shared_members_user ON app_shared_members(username);
    `,
  },
  {
    version: 38,
    sql: `
      -- Credential-local attenuation for external MCP agents. NULL preserves
      -- the authority of credentials minted before this migration; every new
      -- token records a versioned policy document and can only narrow the
      -- account/service grants it derives from.
      ALTER TABLE mcp_tokens ADD COLUMN policy_json TEXT;
    `,
  },
  {
    version: 39,
    sql: `
      -- Additive-only identity metadata. label is a mutable display name (for
      -- example a GitHub login); external_id remains the stable identity
      -- anchor. Existing rows intentionally retain NULL for both new columns.
      ALTER TABLE user_identities ADD COLUMN label TEXT;
      ALTER TABLE user_identities ADD COLUMN created_at TEXT;
    `,
  },
  {
    version: 40,
    sql: `
      -- C2b: schemas shared out of an authenticated dsh instance are durable
      -- capability Object definitions.  The schema is pinned at the instant
      -- the owner shares it; a later catalog update creates another Object
      -- instead of silently changing what an existing grant means.
      --
      -- Tokens are deliberately absent. owner/device are trusted registration
      -- facts, while the plaintext rt_/mcp_ credentials remain one-shot input
      -- whose existing tables store only hashes.
      CREATE TABLE IF NOT EXISTS tentacle_objects (
        object_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        owner TEXT NOT NULL REFERENCES users(username),
        device TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        schema_digest TEXT NOT NULL,
        schema_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tentacle_objects_identity
        ON tentacle_objects(kind, owner, device, resource_key, schema_digest);
      CREATE INDEX IF NOT EXISTS idx_tentacle_objects_owner
        ON tentacle_objects(owner, status, created_at);
    `,
  },
  {
    version: 41,
    sql: `
      -- C3: durable desired/observed state for the one dsh instance assigned
      -- to each Octopus account.  Credentials are deliberately absent: rt_
      -- remains in runner_tokens, mcp_ remains hashed in mcp_tokens, and the
      -- root-only instance environment is outside bot.db.
      CREATE TABLE IF NOT EXISTS fleet_instances (
        username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
        octopus_uid INTEGER NOT NULL UNIQUE,
        instance_id TEXT NOT NULL UNIQUE,
        os_user TEXT NOT NULL UNIQUE,
        public_host TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL UNIQUE,
        desired_state TEXT NOT NULL,
        observed_state TEXT NOT NULL,
        dsh_revision TEXT NOT NULL,
        tentacle_revision TEXT NOT NULL,
        mcp_token_hash TEXT,
        credential_generation INTEGER NOT NULL DEFAULT 0,
        restart_count INTEGER NOT NULL DEFAULT 0,
        last_health_at TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_instances_state
        ON fleet_instances(desired_state, observed_state, updated_at);

      -- A dsh browser session is a child of a real Dashboard browser session.
      -- Only hashes cross the boundary; re-checking source_session_hash makes
      -- ending the Dashboard login end the dsh login on its next request.
      CREATE TABLE IF NOT EXISTS fleet_web_sessions (
        token_hash TEXT PRIMARY KEY,
        source_session_hash TEXT NOT NULL,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        public_host TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        absolute_expiry TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_web_sessions_user
        ON fleet_web_sessions(username, last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_fleet_web_sessions_source
        ON fleet_web_sessions(source_session_hash);
    `,
  },
  {
    version: 42,
    sql: `
      -- H1 P5: exact-byte approval for agent-requested App activation. This is
      -- a devpipe workflow record, not a capability grant and not a kernel
      -- pending call. The unique pair makes a replay of one ticket/digest
      -- return the same durable decision instead of creating another action.
      CREATE TABLE IF NOT EXISTS app_hotswap_approvals (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        app_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        previous_digest TEXT,
        contract_digest TEXT NOT NULL,
        coexistence_verdict TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired','executed')),
        decided_by TEXT,
        decided_at TEXT,
        outcome TEXT,
        UNIQUE(ticket_id, package_digest)
      );
      CREATE INDEX IF NOT EXISTS idx_app_hotswap_approvals_pending
        ON app_hotswap_approvals(state, requested_at, id);
    `,
  },
  {
    version: 43,
    sql: `
      -- C5: version distribution remains an explicit, auditable operation.
      -- Release ids resolve only through the reviewed config/root-helper
      -- catalogs; no URL, package name, profile or command is persisted here.
      ALTER TABLE fleet_instances ADD COLUMN tentacle_desired_release TEXT NOT NULL DEFAULT '';
      ALTER TABLE fleet_instances ADD COLUMN tentacle_observed_release TEXT;
      ALTER TABLE fleet_instances ADD COLUMN tentacle_previous_release TEXT;
      ALTER TABLE fleet_instances ADD COLUMN tentacle_last_attempt_release TEXT;
      ALTER TABLE fleet_instances ADD COLUMN tentacle_upgrade_state TEXT NOT NULL DEFAULT 'disabled'
        CHECK(tentacle_upgrade_state IN ('disabled','idle','upgrading','rolling_back','rejected','failed'));
      ALTER TABLE fleet_instances ADD COLUMN tentacle_upgrade_error TEXT;
      ALTER TABLE fleet_instances ADD COLUMN tentacle_upgrade_started_at TEXT;
      ALTER TABLE fleet_instances ADD COLUMN tentacle_upgrade_completed_at TEXT;
      UPDATE fleet_instances
         SET tentacle_desired_release = 'legacy-' || substr(tentacle_revision, 1, 12),
             tentacle_observed_release = 'legacy-' || substr(tentacle_revision, 1, 12);
      CREATE INDEX IF NOT EXISTS idx_fleet_tentacle_upgrade
        ON fleet_instances(tentacle_upgrade_state, updated_at);
    `,
  },
  {
    version: 44,
    sql: `
      -- B2: provider-neutral session-channel/v1 durable edge state.  Feishu
      -- routing facts stop at the binding row; only opaque binding/session
      -- refs cross the Tentacle boundary.  No app secret, OAuth token,
      -- endpoint, device credential or harness path is stored here.
      -- Preserve the provider's stable event/message id across the existing
      -- graceful-drain queue; random replay ids would defeat exactly-once.
      --
      -- Some supported historical databases were created from a focused
      -- fixture or an installation that skipped the optional channel drain
      -- surface.  Recreate the v11 shape before altering it so upgrading such
      -- a database remains additive; an ordinary v43 production database
      -- already has this table and CREATE IF NOT EXISTS is then a no-op.
      CREATE TABLE IF NOT EXISTS pending_inbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mentioned_bot INTEGER NOT NULL DEFAULT 1,
        received_at TEXT NOT NULL
      );
      ALTER TABLE pending_inbound ADD COLUMN message_id TEXT;

      CREATE TABLE IF NOT EXISTS session_channel_bindings (
        binding_ref TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        client_conversation_ref TEXT NOT NULL,
        session_ref TEXT,
        activity_cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner, client_conversation_ref)
      );

      CREATE TABLE IF NOT EXISTS session_channel_inbox (
        receipt_ref TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        binding_ref TEXT NOT NULL REFERENCES session_channel_bindings(binding_ref) ON DELETE CASCADE,
        client_message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        delivery TEXT NOT NULL CHECK(delivery IN ('followup','steer')),
        status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner, binding_ref, client_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_channel_inbox_work
        ON session_channel_inbox(status, created_at, receipt_ref);

      CREATE TABLE IF NOT EXISTS session_channel_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        binding_ref TEXT NOT NULL REFERENCES session_channel_bindings(binding_ref) ON DELETE CASCADE,
        client_message_id TEXT NOT NULL,
        activity_seq INTEGER NOT NULL,
        activity_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','delivered')) DEFAULT 'pending',
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(binding_ref, activity_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_session_channel_outbox_delivery
        ON session_channel_outbox(status, binding_ref, activity_seq);
    `,
  },
  {
    version: 45,
    sql: `
      -- Canonical authorization intent. These rows are inputs to trusted
      -- capability adapters; none of them is live kernel authority by itself.
      -- authority_id / owner / subject_id deliberately have no user FK:
      -- organization, service, App, and agent identities live in other
      -- compositions and have independent lifecycles.
      CREATE TABLE IF NOT EXISTS authorization_domains (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('personal','organization','workspace','shared')),
        title TEXT NOT NULL,
        authority_type TEXT NOT NULL CHECK(authority_type IN ('owner','organization')),
        authority_id TEXT NOT NULL,
        history_policy TEXT NOT NULL CHECK(history_policy IN ('all','since_join')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_authorization_domains_authority
        ON authorization_domains(authority_type, authority_id, kind, id);

      CREATE TABLE IF NOT EXISTS authorization_resources (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        domain_id TEXT NOT NULL REFERENCES authorization_domains(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','sensitive','credential')),
        external_system TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(external_system, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_authorization_resources_domain
        ON authorization_resources(domain_id, owner, kind, id);
      CREATE INDEX IF NOT EXISTS idx_authorization_resources_owner
        ON authorization_resources(owner, domain_id, id);

      -- Absence is deny. Revocation marks rather than deletes so an exact
      -- authority decision remains explainable after it stops being active.
      CREATE TABLE IF NOT EXISTS authorization_permits (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('user','app','agent','service')),
        subject_id TEXT NOT NULL,
        resource_id TEXT NOT NULL REFERENCES authorization_resources(id),
        operation TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('ask','allow')),
        authority_type TEXT NOT NULL CHECK(authority_type IN ('owner','organization')),
        authority_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('user','admin','system-policy','bootstrap','migration')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_by TEXT,
        revoked_at TEXT,
        CHECK(
          (revoked_by IS NULL AND revoked_at IS NULL)
          OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_authorization_permits_active_exact
        ON authorization_permits(
          subject_type, subject_id, resource_id, operation,
          authority_type, authority_id
        ) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_authorization_permits_resource
        ON authorization_permits(resource_id, revoked_at, subject_type, subject_id, operation);
      CREATE INDEX IF NOT EXISTS idx_authorization_permits_subject
        ON authorization_permits(subject_type, subject_id, revoked_at, resource_id);

      -- Product defaults only seed a future App-install draft. Reading this
      -- row never grants an App anything and AuthorizationService does not
      -- consult it while deciding access.
      CREATE TABLE IF NOT EXISTS authorization_owner_defaults (
        owner TEXT PRIMARY KEY,
        profile_version INTEGER NOT NULL CHECK(profile_version = 1),
        profile_json TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 46,
    sql: `
      -- Ticket #192: what a ticket cost, so the board can show whether this
      -- system is getting harder to change before anyone reads a diff.
      --
      -- Cost columns accumulate across turns and are NOT NULL/0 because "no
      -- turn has run yet" and "the turn spent nothing" are both honestly zero.
      -- Diff columns stay nullable: they are written once, by the landing that
      -- fast-forwarded the range, and NULL means "never landed" rather than
      -- "landed an empty change". Rows that landed before this migration keep
      -- NULL — the panel renders them blank instead of claiming a zero diff.
      ALTER TABLE dev_tickets ADD COLUMN agent_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dev_tickets ADD COLUMN agent_turns INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dev_tickets ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dev_tickets ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dev_tickets ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dev_tickets ADD COLUMN diff_files INTEGER;
      ALTER TABLE dev_tickets ADD COLUMN diff_modules INTEGER;
      ALTER TABLE dev_tickets ADD COLUMN diff_added INTEGER;
      ALTER TABLE dev_tickets ADD COLUMN diff_removed INTEGER;
    `,
  },
  {
    version: 47,
    sql: `
      -- Ticket #201: an agent that finished the work AND left a question.
      --
      -- Before this column the board had exactly two shapes for a finished
      -- turn: 'open' (still a conversation) and 'landed' (a package waiting to
      -- deploy). An agent that landed half a ticket and said "the other half
      -- needs your decision" produced the second one, so the board announced
      -- success and the question sat unread inside a transcript nobody had a
      -- reason to reopen.
      --
      -- It is deliberately a nullable TEXT rather than another dev_status: the
      -- code really did land, the deploy axis really is pending, and folding a
      -- question into that axis would make "is this deployable" and "does this
      -- need me" the same field. NULL means no question was asked; a non-empty
      -- string is the agent's own sentence, shown verbatim.
      ALTER TABLE dev_tickets ADD COLUMN open_question TEXT;
    `,
  },
  {
    version: 48,
    sql: `
      -- Ticket #219: what a CI repair ticket is accountable for.
      --
      -- JSON array of repo-relative spec files, parsed from the red batch's own
      -- digest. The land gate runs them against the candidate tree before any
      -- landing fast-forwards the base branch, which is what stops an
      -- unverified guess from spending a 20-45 minute batch to be told "still
      -- red" (measured: seven consecutive landings on one failure, v4
      -- 1c9928c..716ad3f).
      --
      -- Nullable, and the NULL/non-NULL distinction carries meaning that an
      -- empty-string default would destroy: NULL = an ordinary ticket, '[]' =
      -- a CI repair ticket whose trace had no parseable roster (infrastructure
      -- failure, a suite that never started). The second still needs the repair
      -- contract, so the marker has to be the column's presence rather than its
      -- contents. Rows created before this migration are ordinary tickets and
      -- correctly read as NULL.
      ALTER TABLE dev_tickets ADD COLUMN ci_roster TEXT;
    `,
  },
  {
    version: 49,
    sql: `
      -- Ticket #238: \`external-app-host/v1\` — a logged-in person handing ONE
      -- external trusted host (a DSH instance on an allow-listed origin) the
      -- right to drive ONE App instance they are already seated in.
      --
      -- Two tables because there are two credentials with two lifetimes, and
      -- collapsing them would make "was this link ever redeemed" and "is this
      -- binding still live" the same row:
      --
      --  · a LAUNCH GRANT is a one-shot, seconds-long handoff. It exists so the
      --    secret the browser navigates with is never the standing credential:
      --    it rides a URL fragment, is exchanged once, and is dead afterwards
      --    whether or not the exchange succeeded. \`consumed_at\` MARKS rather
      --    than deletes so a replay is answerable as a replay.
      --  · an EXTERNAL CAPABILITY is the standing credential, and every field
      --    that is not bookkeeping is a BINDING it may never widen: the real
      --    username (never a name the host asserts), the app, the shared
      --    instance, the release digest that was active when the person agreed,
      --    the host it may be presented from, and whether it carries HUMAN or
      --    AGENT authority. Agent authority is a separate row minted by a
      --    separate act on a trusted Octopus page — an external host cannot ask
      --    for it and cannot promote a human binding into one.
      --
      -- Only sha256 digests of both secrets are stored, exactly as
      -- dashboard_tokens/mcp_tokens do: a database leak must not yield a
      -- connectable credential. The plaintext exists once, in the reply that
      -- minted it.
      --
      -- No foreign key to app_shared_instances/app_shared_members on purpose:
      -- a capability is deliberately NOT authority by itself. Membership, App
      -- trust, the instance's status and the active release are re-read on
      -- every single call, so a row that survives a seat being taken away is a
      -- row that fails closed rather than a grant that outlived its reason.
      CREATE TABLE IF NOT EXISTS app_external_launch_grants (
        grant_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        app_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        username TEXT NOT NULL,
        host_id TEXT NOT NULL,
        host_origin TEXT NOT NULL,
        release_digest TEXT NOT NULL,
        authority TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_credential TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_app_external_grants_user
        ON app_external_launch_grants(username, app_id);
      CREATE TABLE IF NOT EXISTS app_external_capabilities (
        credential_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        app_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        username TEXT NOT NULL,
        host_id TEXT NOT NULL,
        host_origin TEXT NOT NULL,
        release_digest TEXT NOT NULL,
        authority TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_app_external_caps_user
        ON app_external_capabilities(username, app_id);
    `,
  },
  {
    version: 50,
    sql: `
      -- Knowledge recovery is deliberately two-layered:
      --   * ticket_landings is the immutable, exact commit-range ledger;
      --   * knowledge_records/links are a rebuildable semantic projection.
      -- A failed or improved indexer may be rerun without rewriting history.
      CREATE TABLE IF NOT EXISTS ticket_landings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        from_sha TEXT NOT NULL,
        to_sha TEXT NOT NULL,
        base_before TEXT NOT NULL,
        tip_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        landed_at TEXT,
        source TEXT NOT NULL,
        report_path TEXT,
        summary TEXT NOT NULL,
        changed_files TEXT NOT NULL,
        changed_modules TEXT NOT NULL,
        verification TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        knowledge_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(ticket_id, to_sha)
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_landings_range
        ON ticket_landings(from_sha, to_sha);
      CREATE INDEX IF NOT EXISTS idx_ticket_landings_created
        ON ticket_landings(created_at DESC);

      CREATE TABLE IF NOT EXISTS knowledge_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        authority TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_sha TEXT,
        ticket_id INTEGER REFERENCES dev_tickets(id),
        confidence REAL NOT NULL,
        metadata TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_records_source
        ON knowledge_records(source_type, source_ref);
      CREATE INDEX IF NOT EXISTS idx_knowledge_records_ticket
        ON knowledge_records(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_records_lifecycle
        ON knowledge_records(kind, status, authority);

      CREATE TABLE IF NOT EXISTS knowledge_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_key TEXT NOT NULL REFERENCES knowledge_records(record_key) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(from_key, relation, target_type, target_key)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_links_target
        ON knowledge_links(target_type, target_key, relation);

      -- Trigram supports Chinese phrases, paths and identifiers with one
      -- deterministic local index. It is a retrieval aid, never authority.
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        record_key UNINDEXED,
        title,
        body,
        source_ref,
        tokenize='trigram'
      );
    `,
  },
  {
    version: 51,
    sql: `
      -- Contributor lane (2026-08-20). A ticket's lane decides what
      -- devpipe_submit does with a verified candidate:
      --   'direct'  fast-forward the base branch (the historical behaviour);
      --   'review'  push a contrib/<user>/ticket-<id> branch, run CI, open a
      --             merge request and wait for a maintainer's decision.
      -- Additive: every existing row is 'direct', which is exactly what it was.
      ALTER TABLE dev_tickets ADD COLUMN lane TEXT NOT NULL DEFAULT 'direct';

      -- One row per published candidate of a review-lane ticket. A ticket may
      -- publish several times (each resubmit supersedes the live one); the
      -- maintainer's decision and the merge outcome are recorded on the row,
      -- never on the ticket, so the ticket stays a conversation.
      CREATE TABLE IF NOT EXISTS merge_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        requester TEXT NOT NULL,
        branch TEXT NOT NULL,
        sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        pipeline_id TEXT,
        pipeline_url TEXT,
        mr_iid INTEGER,
        mr_url TEXT,
        review_by TEXT,
        review_at TEXT,
        review_note TEXT,
        merge_ticket_id INTEGER REFERENCES dev_tickets(id),
        merged_sha TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_merge_proposals_ticket ON merge_proposals(ticket_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_merge_proposals_status ON merge_proposals(status);
    `,
  },
  {
    version: 52,
    sql: `
      -- Knowledge review ledger (2026-08-21). The derived knowledge graph routes
      -- conflict candidates and ambiguous records to people and never resolves
      -- them; a reviewer's decision lives here as append-only runtime state
      -- keyed by the subject's stable id, so it survives graph rebuilds and is
      -- never mistaken for knowledge. Knowledge itself still changes through
      -- tickets and curated files in Git.
      CREATE TABLE IF NOT EXISTS knowledge_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL,
        rule TEXT NOT NULL,
        decision TEXT NOT NULL,
        note TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_reviews_subject ON knowledge_reviews (subject_id, id);
    `,
  },
  {
    version: 53,
    sql: `
      -- Ticket #298: authorization resources receive a canonical hierarchical
      -- URI. The immutable resource id remains the exact permit target; URI
      -- aliases are owner-scoped locators and can never retarget a permit that
      -- was already written.
      ALTER TABLE authorization_resources ADD COLUMN uri TEXT;
      UPDATE authorization_resources
         SET uri = 'object://legacy/s/' || (
           WITH RECURSIVE system_chunks(remaining, path) AS (
             SELECT lower(hex(external_system)), ''
             UNION ALL
             SELECT
               substr(remaining, 257),
               path || CASE WHEN path = '' THEN '' ELSE '/' END || substr(remaining, 1, 256)
             FROM system_chunks
             WHERE remaining <> ''
           )
           SELECT path FROM system_chunks WHERE remaining = ''
         ) || '/i/' || (
           WITH RECURSIVE id_chunks(remaining, path) AS (
             SELECT lower(hex(external_id)), ''
             UNION ALL
             SELECT
               substr(remaining, 257),
               path || CASE WHEN path = '' THEN '' ELSE '/' END || substr(remaining, 1, 256)
             FROM id_chunks
             WHERE remaining <> ''
           )
           SELECT path FROM id_chunks WHERE remaining = ''
         )
       WHERE uri IS NULL;
      CREATE UNIQUE INDEX idx_authorization_resources_uri ON authorization_resources(uri);
      CREATE TRIGGER authorization_resources_uri_required_insert
        BEFORE INSERT ON authorization_resources
        WHEN NEW.uri IS NULL OR NEW.uri = ''
        BEGIN
          SELECT RAISE(ABORT, 'authorization resource uri is required');
        END;
      CREATE TRIGGER authorization_resources_uri_required_update
        BEFORE UPDATE OF uri ON authorization_resources
        WHEN NEW.uri IS NULL OR NEW.uri = ''
        BEGIN
          SELECT RAISE(ABORT, 'authorization resource uri is required');
        END;

      -- Alias history is append-only. One partial unique index names the active
      -- edge; replacing or deleting a link first revokes that edge so past
      -- permission explanations remain attributable.
      CREATE TABLE authorization_resource_aliases (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        alias_uri TEXT NOT NULL,
        target_uri TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_by TEXT,
        revoked_at TEXT,
        CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
      );
      CREATE UNIQUE INDEX idx_authorization_resource_aliases_active
        ON authorization_resource_aliases(alias_uri) WHERE revoked_at IS NULL;
      CREATE INDEX idx_authorization_resource_aliases_owner
        ON authorization_resource_aliases(owner, revoked_at, alias_uri);
    `,
  },
  {
    version: 54,
    sql: `
      -- Direct Codex account routing (2026-08-22). Only an operator-defined,
      -- opaque slot is persisted: credentials, account metadata and CODEX_HOME
      -- paths remain configuration/runtime state. NULL preserves the legacy
      -- default-home behaviour for existing Codex sessions and all other CLIs.
      ALTER TABLE dev_tickets ADD COLUMN codex_account_slot TEXT;
    `,
  },
  {
    version: 55,
    sql: `
      -- Resource waiters (2026-08-22, resources/recovery.ts): which agent
      -- scope (a ticket turn, a chat session) was told "resource X is away,
      -- you will be notified". Kept here rather than in memory so a bot
      -- restart in the middle of an outage does not forget the promise.
      CREATE TABLE IF NOT EXISTS resource_waiters (
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        detail TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (scope, resource)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_waiters_resource ON resource_waiters(resource);
    `,
  },
  {
    version: 56,
    sql: `
      -- Retrieval telemetry is append-only operational evidence, never a
      -- knowledge source. Envelopes contain only keyed query fingerprints and
      -- immutable index bindings; bounded allowlisted events carry the audit.
      CREATE TABLE knowledge_retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        lane TEXT NOT NULL CHECK (lane IN ('ticket', 'cli')),
        purpose TEXT NOT NULL CHECK (purpose IN ('startup', 'path_refinement', 'submit_check')),
        subject_ref TEXT NOT NULL,
        turn INTEGER,
        parent_trace_id TEXT,
        journey_step_id TEXT,
        query_hash TEXT NOT NULL,
        query_chars INTEGER NOT NULL CHECK (query_chars >= 0),
        repo_sha TEXT NOT NULL,
        worktree_input_fingerprint TEXT,
        graph_input_fingerprint TEXT NOT NULL,
        code_index_sha TEXT,
        vector_index_sha TEXT,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_retrieval_subject
        ON knowledge_retrieval_traces(subject_ref, started_at DESC);
      CREATE INDEX idx_knowledge_retrieval_expiry
        ON knowledge_retrieval_traces(expires_at);

      CREATE TABLE knowledge_retrieval_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL REFERENCES knowledge_retrieval_traces(trace_id) ON DELETE CASCADE,
        event TEXT NOT NULL CHECK (event IN (
          'started', 'assembled', 'miss', 'error', 'delivered',
          'delivered_error', 'abandoned', 'reported_use', 'feedback'
        )),
        event_key TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (length(CAST(payload_json AS BLOB)) <= 24576),
        created_at TEXT NOT NULL,
        UNIQUE(trace_id, event_key)
      );
      CREATE INDEX idx_knowledge_retrieval_events_trace
        ON knowledge_retrieval_events(trace_id, id);
    `,
  },
  {
    version: 57,
    sql: `
      -- A Runner credential proves which device connected; it does not by
      -- itself let that device initiate work on sibling devices.  Keep the
      -- user-controlled initiator policy separate so token rotation and
      -- Runner self-update cannot silently expand an old credential.
      CREATE TABLE runner_device_policies (
        username TEXT NOT NULL,
        device TEXT NOT NULL,
        local_agent_bridge_mode TEXT NOT NULL DEFAULT 'disabled'
          CHECK (local_agent_bridge_mode IN ('disabled', 'manual', 'full_access')),
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (username, device),
        FOREIGN KEY (username, device) REFERENCES runner_tokens(username, device) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 58,
    sql: `
      -- Managed split-session recovery (#370). This is placement and the hash
      -- of the currently issued short-lived credential, never its bearer.
      -- Runner/Bot restarts can therefore rotate a fresh scope for the exact
      -- authenticated runtime device + provider session without persisting a
      -- reusable secret or widening the original 24-hour authority lifetime.
      CREATE TABLE session_execution_bindings (
        owner TEXT NOT NULL,
        runtime_device TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('claude', 'codex', 'omp')),
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        execution_device TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        permission_profile TEXT NOT NULL CHECK(permission_profile IN ('full_access', 'manual')),
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(owner, runtime_device, source, session_id)
      );
      CREATE INDEX idx_session_execution_bindings_expiry
        ON session_execution_bindings(expires_at);
    `,
  },
  {
    version: 59,
    sql: `
      -- FIFO merge-lock waiting intent. The in-memory coordinator still owns
      -- reservations and fencing; this table preserves only arrival order so
      -- a bot restart cannot forget idle agents that already ended their turn.
      CREATE TABLE dev_merge_waiters (
        ticket_id INTEGER PRIMARY KEY REFERENCES dev_tickets(id) ON DELETE CASCADE,
        queue_sequence INTEGER NOT NULL UNIQUE,
        queued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_dev_merge_waiters_fifo
        ON dev_merge_waiters(queue_sequence);
    `,
  },
  {
    version: 60,
    sql: `
      -- Knowledge conflict collaboration (#404). A conflict id belongs to the
      -- rebuildable graph, so ticket bindings deliberately carry no foreign
      -- key: the audit must outlive the candidate that a later rebuild removes.
      ALTER TABLE dev_tickets ADD COLUMN knowledge_subject_id TEXT;
      CREATE INDEX idx_dev_tickets_knowledge_subject
        ON dev_tickets(knowledge_subject_id, id DESC)
        WHERE knowledge_subject_id IS NOT NULL;

      -- User annotations are shared review evidence, not knowledge. Actor stays
      -- textual so append-only history survives account lifecycle changes.
      CREATE TABLE knowledge_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 400),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
        actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 64),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_annotations_subject
        ON knowledge_annotations(subject_id, id);
    `,
  },
  {
    version: 61,
    sql: `
      -- Knowledge Chat is personal conversation data, not development work.
      -- Its rows deliberately do not reference dev_tickets. subject_id points
      -- at the rebuildable graph, so it carries no foreign key and survives a
      -- graph rebuild; username follows the account lifecycle and cascades.
      CREATE TABLE knowledge_chats (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        subject_id TEXT CHECK(subject_id IS NULL OR length(subject_id) BETWEEN 1 AND 400),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
        preview TEXT NOT NULL CHECK(length(preview) BETWEEN 1 AND 4000),
        request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 8 AND 80),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        running_since TEXT,
        UNIQUE(username, request_id)
      );
      CREATE INDEX idx_knowledge_chats_owner
        ON knowledge_chats(username, updated_at DESC, id DESC);
      CREATE INDEX idx_knowledge_chats_subject
        ON knowledge_chats(username, subject_id, updated_at DESC)
        WHERE subject_id IS NOT NULL;

      CREATE TABLE knowledge_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES knowledge_chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'error')),
        content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 8000),
        request_id TEXT CHECK(request_id IS NULL OR length(request_id) BETWEEN 8 AND 80),
        at TEXT NOT NULL,
        UNIQUE(chat_id, request_id)
      );
      CREATE INDEX idx_knowledge_chat_messages
        ON knowledge_chat_messages(chat_id, id);
    `,
  },
  {
    version: 62,
    sql: `
      -- Delivery is classified from the final diff at submit time, not chosen
      -- by the requester before the implementation is known (#424).
      --
      -- NULL preserves the historical interpretation: legacy App tickets are
      -- App-only and every other ticket is full-deploy. New landings record
      -- one explicit mode. delivery_apps is the exact JSON App-id set only for
      -- app_releases; the pipeline validates and writes it in the same landing
      -- transition as deploy_status.
      ALTER TABLE dev_tickets ADD COLUMN delivery_mode TEXT
        CHECK(delivery_mode IS NULL OR delivery_mode IN ('full_deploy', 'app_releases', 'none'));
      ALTER TABLE dev_tickets ADD COLUMN delivery_apps TEXT;

      -- A multi-App submit can legitimately produce identical package hashes
      -- for two Apps (and test fixtures commonly do). Approval identity must
      -- include the App id; the v42 ticket/digest pair otherwise aliases the
      -- second App to the first one's authority and drops one channel.
      CREATE TABLE app_hotswap_approvals_v62 (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        app_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        previous_digest TEXT,
        contract_digest TEXT NOT NULL,
        coexistence_verdict TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired','executed')),
        decided_by TEXT,
        decided_at TEXT,
        outcome TEXT,
        UNIQUE(ticket_id, app_id, package_digest)
      );
      INSERT INTO app_hotswap_approvals_v62
        SELECT * FROM app_hotswap_approvals;
      DROP TABLE app_hotswap_approvals;
      ALTER TABLE app_hotswap_approvals_v62 RENAME TO app_hotswap_approvals;
      CREATE INDEX idx_app_hotswap_approvals_pending
        ON app_hotswap_approvals(state, requested_at, id);
    `,
  },
  {
    version: 63,
    sql: `
      -- Runner installation enrollment is deliberately not a device
      -- credential. The short-lived, one-shot hash may be copied through a
      -- shell command; only successful redemption mints the durable rt_ token
      -- that stays on the target device.
      CREATE TABLE runner_enrollments (
        code_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        device TEXT NOT NULL CHECK(length(device) BETWEEN 1 AND 32),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX idx_runner_enrollments_expiry
        ON runner_enrollments(expires_at);
      CREATE UNIQUE INDEX idx_runner_enrollments_pending_device
        ON runner_enrollments(username, device)
        WHERE consumed_at IS NULL;
    `,
  },
  {
    version: 64,
    sql: `
      -- A Runner client is a separately activated production artifact. A
      -- trusted-code deployment changes the checkout, but the gateway and
      -- installer continue serving the durable active pointer until this debt
      -- is settled. One row per ticket preserves which delivery must remain
      -- visibly pending; unlike App debt, several tickets can be covered by
      -- one later whole-tree bundle activation.
      CREATE TABLE runner_bundle_pending (
        ticket_id INTEGER PRIMARY KEY REFERENCES dev_tickets(id) ON DELETE CASCADE,
        commit_sha TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        last_attempt_at TEXT,
        candidate_sha TEXT,
        last_error TEXT
      );
      CREATE INDEX idx_runner_bundle_pending_commit
        ON runner_bundle_pending(commit_sha, ticket_id);

      -- Attempts are immutable operational audit. The active pointer itself
      -- stays in runner-bundles/state.json because the Runner gateway must be
      -- able to serve and roll it back without SQLite being its data plane.
      CREATE TABLE runner_bundle_activation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_commit TEXT NOT NULL,
        candidate_sha TEXT,
        previous_sha TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('activated', 'unchanged', 'failed')),
        actor TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX idx_runner_bundle_activation_audit_recent
        ON runner_bundle_activation_audit(id DESC);
    `,
  },
  {
    version: 65,
    sql: `
      -- Local Agent cross-Runner MCP/prompt injection is a separate choice
      -- from whether calls made through that bridge need approval. Existing
      -- and newly enrolled devices stay closed until their owner explicitly
      -- enables the device-level default injection switch.
      ALTER TABLE runner_device_policies
        ADD COLUMN default_agent_injection INTEGER NOT NULL DEFAULT 0
          CHECK(default_agent_injection IN (0, 1));
    `,
  },
  {
    version: 66,
    sql: `
      -- Token credits are an append-only accounting fact. The balance table is
      -- only a transactionally maintained projection and may be rebuilt from
      -- the entries without consulting ticket/session transcripts.
      CREATE TABLE credit_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        delta INTEGER NOT NULL CHECK(typeof(delta) = 'integer'),
        reason TEXT NOT NULL CHECK(reason IN ('ticket_earn', 'session_spend', 'admin_adjust')),
        ref_kind TEXT NOT NULL CHECK(length(ref_kind) BETWEEN 1 AND 80),
        ref_id TEXT NOT NULL CHECK(length(ref_id) BETWEEN 1 AND 240),
        created_at TEXT NOT NULL,
        UNIQUE(reason, ref_kind, ref_id),
        CHECK(
          (reason = 'ticket_earn' AND delta >= 0)
          OR (reason = 'session_spend' AND delta <= 0)
          OR reason = 'admin_adjust'
        )
      );
      CREATE INDEX idx_credit_entries_user
        ON credit_entries(username, id DESC);
      CREATE TRIGGER credit_entries_no_update
        BEFORE UPDATE ON credit_entries
        BEGIN SELECT RAISE(ABORT, 'credit_entries are append-only'); END;
      CREATE TRIGGER credit_entries_no_delete
        BEFORE DELETE ON credit_entries
        BEGIN SELECT RAISE(ABORT, 'credit_entries are append-only'); END;

      CREATE TABLE credit_balances (
        username TEXT PRIMARY KEY,
        balance INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- A split session may run under a resource owner's authenticated Runner
      -- while every executable capability remains rooted in the caller. These
      -- two bearer-free coordinates let dispatch/recovery and billing re-check
      -- the exact canonical permit without treating a device label as authority.
      ALTER TABLE session_execution_bindings ADD COLUMN runtime_owner TEXT;
      ALTER TABLE session_execution_bindings ADD COLUMN runtime_resource_id TEXT;
      UPDATE session_execution_bindings SET runtime_owner = owner WHERE runtime_owner IS NULL;
      CREATE INDEX idx_session_execution_bindings_runtime
        ON session_execution_bindings(runtime_owner, runtime_device, source, session_id);
    `,
  },
  {
    version: 67,
    sql: `
      -- Durable provenance for Sessions+ sessions whose provider runs on a
      -- different Runner from their execution workspace. This is deliberately
      -- separate from session_execution_bindings: those rows expire with a
      -- 24-hour execution credential, while roster/read provenance must remain
      -- useful for the lifetime of the provider transcript.
      --
      -- catalog_id is a Host-minted correlation value stored in the Runner's
      -- placement record. NULL marks an older row backfilled from the existing
      -- trusted execution binding; legacy rows are still matched by the exact
      -- provider/session/execution/workspace tuple and never by cwd or title.
      CREATE TABLE session_plus_split_sessions (
        owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        runtime_owner TEXT NOT NULL,
        runtime_device TEXT NOT NULL CHECK(length(runtime_device) BETWEEN 1 AND 64),
        runtime_resource_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('claude', 'codex', 'omp')),
        session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 200),
        catalog_id TEXT CHECK(
          catalog_id IS NULL OR (
            length(catalog_id) = 68
            AND substr(catalog_id, 1, 4) = 'spc_'
            AND substr(catalog_id, 5) NOT GLOB '*[^0-9a-f]*'
          )
        ),
        execution_device TEXT NOT NULL CHECK(length(execution_device) BETWEEN 1 AND 64),
        workspace_id TEXT NOT NULL CHECK(
          length(workspace_id) = 27
          AND substr(workspace_id, 1, 3) = 'ws_'
          AND substr(workspace_id, 4) NOT GLOB '*[^0-9a-f]*'
        ),
        workspace_label TEXT NOT NULL DEFAULT '',
        workspace_display TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(owner, runtime_device, source, session_id)
      );
      CREATE INDEX idx_session_plus_split_runtime
        ON session_plus_split_sessions(runtime_owner, runtime_device, source, session_id);
      CREATE INDEX idx_session_plus_split_owner_recent
        ON session_plus_split_sessions(owner, updated_at DESC);

      -- Preserve every still-retained pre-v67 split placement. Rows whose
      -- short-lived execution binding was already revoked remain fail-closed:
      -- neither workspace labels nor Runner-local placement alone prove which
      -- Octopus account may see them.
      INSERT INTO session_plus_split_sessions (
        owner, runtime_owner, runtime_device, runtime_resource_id, source,
        session_id, catalog_id, execution_device, workspace_id,
        workspace_label, workspace_display, created_at, updated_at
      )
      SELECT owner, COALESCE(runtime_owner, owner), runtime_device,
        runtime_resource_id, source, session_id, NULL, execution_device,
        workspace_id, '', '', created_at, updated_at
      FROM session_execution_bindings;
    `,
  },
  {
    version: 68,
    sql: `
      -- Discoverability is not an active GUI-control grant. It only lets an
      -- eligible macOS Runner appear in the MCP target catalog; every control
      -- lease still requires a target-local dialog and expires after 15 min.
      ALTER TABLE runner_device_policies
        ADD COLUMN gui_automation_enabled INTEGER NOT NULL DEFAULT 0
          CHECK(gui_automation_enabled IN (0, 1));
    `,
  },
  {
    version: 69,
    sql: `
      -- Optional display attribution, separate from deploy authority and errors.
      -- No FK: historical attribution survives ticket/account lifecycle changes.
      ALTER TABLE deploy_intents ADD COLUMN trigger_source TEXT;
    `,
  },
  {
    version: 70,
    sql: `
      CREATE TRIGGER knowledge_reviews_no_update BEFORE UPDATE ON knowledge_reviews
        BEGIN SELECT RAISE(ABORT, 'knowledge reviews are append-only'); END;
      CREATE TRIGGER knowledge_reviews_no_delete BEFORE DELETE ON knowledge_reviews
        BEGIN SELECT RAISE(ABORT, 'knowledge reviews are append-only'); END;
      CREATE TABLE knowledge_review_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        target_sha TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(subject_id, fingerprint)
      );
      CREATE TRIGGER knowledge_review_candidates_no_update BEFORE UPDATE ON knowledge_review_candidates
        BEGIN SELECT RAISE(ABORT, 'knowledge review candidates are append-only'); END;
      CREATE TRIGGER knowledge_review_candidates_no_delete BEFORE DELETE ON knowledge_review_candidates
        BEGIN SELECT RAISE(ABORT, 'knowledge review candidates are append-only'); END;
    `,
  },
  {
    version: 71,
    sql: `
      -- No user FK: guests have scoped browser identities, never account roots.
      CREATE TABLE session_shares (id TEXT PRIMARY KEY, owner TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
      CREATE INDEX session_shares_owner ON session_shares(owner);
      CREATE TABLE session_share_members (share_id TEXT NOT NULL REFERENCES session_shares(id), viewer TEXT NOT NULL, PRIMARY KEY(share_id, viewer));
      CREATE TABLE session_share_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL REFERENCES session_shares(id), requester TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('budget','lease')), status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')), created_at INTEGER NOT NULL, resolved_at INTEGER);
      CREATE TABLE session_share_usage_events (event_key TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES session_shares(id), tokens INTEGER NOT NULL, completed_at TEXT NOT NULL);
      CREATE UNIQUE INDEX session_share_request_pending ON session_share_requests(share_id, requester, kind) WHERE status = 'pending';
    `,
  },
  {
    version: 72,
    sql: `
      -- Historical discussion participants survive account removal; no user FK.
      -- IDs/records carry no provider credentials or account capabilities.
      CREATE TABLE discussions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, chat_id TEXT UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(owner, request_id));
      CREATE TABLE discussion_members(discussion_id TEXT NOT NULL REFERENCES discussions(id), username TEXT NOT NULL, PRIMARY KEY(discussion_id, username));
      CREATE INDEX discussion_members_user ON discussion_members(username, discussion_id);
      CREATE TABLE discussion_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id TEXT NOT NULL REFERENCES discussions(id), external_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('human','assistant')), triage TEXT NOT NULL CHECK(triage IN ('pending','quiet','wake')), reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(discussion_id, external_id));
      CREATE INDEX discussion_messages_pending ON discussion_messages(discussion_id, triage, seq);
      CREATE TABLE discussion_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id TEXT NOT NULL REFERENCES discussions(id), agent TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX discussion_events_room ON discussion_events(discussion_id, seq);
      CREATE TABLE discussion_outbox(id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL REFERENCES discussions(id), text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown','cancelled')), message_id TEXT);
      CREATE INDEX discussion_outbox_room ON discussion_outbox(discussion_id, status);
    `,
  },
  {
    version: 73,
    sql: `
      CREATE TABLE dev_runner_bindings(ticket_id INTEGER PRIMARY KEY REFERENCES dev_tickets(id), binding TEXT NOT NULL);
      CREATE TABLE dev_runner_turns(id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id), state TEXT NOT NULL, record TEXT NOT NULL);
      CREATE UNIQUE INDEX dev_runner_turn_active ON dev_runner_turns(ticket_id) WHERE state <> 'finished';
    `,
  },
  {
    version: 74,
    sql: `
      -- Input evidence is separate from the legacy provider completion status.
      -- Routing contains only exact identities, never prompts or credentials.
      ALTER TABLE session_operations ADD COLUMN input_receipt TEXT;
      ALTER TABLE session_operations ADD COLUMN runner_operation_id TEXT;
      ALTER TABLE session_operations ADD COLUMN runner_receipt_target TEXT;
      CREATE INDEX session_operations_receipt_recovery ON session_operations(status)
        WHERE runner_operation_id IS NOT NULL;
    `,
  },
  {
    version: 75,
    sql: `
      -- Ticket-owned execution placement and immutable candidate evidence. No credentials.
      CREATE TABLE dev_development_bindings(ticket_id INTEGER PRIMARY KEY REFERENCES dev_tickets(id), record TEXT NOT NULL, candidate TEXT);
      CREATE TABLE dev_development_operations(id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id), operation_key TEXT NOT NULL, attempt INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(ticket_id,operation_key,attempt));
      CREATE INDEX dev_development_operations_ticket ON dev_development_operations(ticket_id, operation_key);
    `,
  },
  {
    version: 76,
    sql: `
      -- Chat control is independent of development/production lifecycle.
      ALTER TABLE dev_tickets ADD COLUMN chat_paused INTEGER NOT NULL DEFAULT 0 CHECK(chat_paused IN (0,1));
      -- delivered_turn retains inbox custody for old versions. Delivery evidence
      -- is now explicit and must not be inferred from that scheduling marker.
      ALTER TABLE ticket_messages ADD COLUMN delivery_state TEXT CHECK(delivery_state IN ('sending','delivered','failed','unknown'));
      ALTER TABLE ticket_messages ADD COLUMN delivery_error TEXT;
      ALTER TABLE ticket_messages ADD COLUMN delivery_input TEXT;
      CREATE TABLE dev_runner_inputs (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        turn_id TEXT NOT NULL REFERENCES dev_runner_turns(id),
        state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','accepted','failed','unknown','queued')),
        record TEXT NOT NULL
      );
      CREATE INDEX dev_runner_inputs_turn ON dev_runner_inputs(turn_id, state);
    `,
  },
  {
    version: 77,
    sql: `
      -- Recovery metadata and private checkpoints. Identity may refer to a
      -- Runner or App-owned domain, so no cross-lifecycle foreign key is used.
      CREATE TABLE managed_executions (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        source TEXT NOT NULL,
        desired TEXT NOT NULL CHECK(desired IN ('running','paused','cancelled')),
        observed TEXT NOT NULL,
        next_retry_at TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        record TEXT NOT NULL
      );
      CREATE INDEX managed_executions_owner ON managed_executions(owner, id);
      CREATE INDEX managed_executions_ready ON managed_executions(source, desired, observed, next_retry_at);
    `,
  },
  {
    version: 78,
    sql: `
      CREATE TABLE knowledge_source_drafts (
        ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id) ON DELETE CASCADE, source_ref TEXT NOT NULL,
        source_sha256 TEXT NOT NULL, record TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(ticket_id,source_ref)
      );
      -- Selected private CLI messages are not graph inputs. Owner participates in every lookup.
      CREATE TABLE knowledge_cli_sources(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE, record TEXT NOT NULL);
      CREATE INDEX knowledge_cli_sources_owner ON knowledge_cli_sources(owner,id);
      CREATE TABLE knowledge_cli_confirmations(
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES knowledge_cli_sources(id) ON DELETE CASCADE, event TEXT NOT NULL
      );
      CREATE INDEX knowledge_cli_confirmations_owner ON knowledge_cli_confirmations(owner,source_id,id);
      -- Operational content repair workflow, distinct from design approval and derived graph facts.
      CREATE TABLE knowledge_repairs(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        problem TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('candidate','investigated','landed','verified')),
        record TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(record_id,fingerprint,problem));
      CREATE TABLE knowledge_repair_observations(repair_id TEXT NOT NULL REFERENCES knowledge_repairs(id),
        observation_key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(repair_id,observation_key));
    `,
  },
  {
    version: 79,
    sql: `
      -- Project identities belong to the shared App registry. Records survive
      -- App release retirement and do not carry credentials or live grants.
      CREATE TABLE research_records (
        project TEXT NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        version INTEGER NOT NULL, record TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY(project, bucket, id)
      );
      CREATE UNIQUE INDEX research_records_sequence ON research_records(project, sequence);
      CREATE INDEX research_records_status ON research_records(project, bucket, json_extract(record, '$.status'), sequence);
      CREATE INDEX research_records_node ON research_records(project, bucket, json_extract(record, '$.node'), sequence);
      CREATE INDEX research_records_conversation ON research_records(project, bucket, json_extract(record, '$.conversation'), sequence);
      CREATE TABLE research_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
        bucket TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX research_changes_project ON research_changes(project, seq);
      CREATE TABLE research_requests (
        project TEXT NOT NULL, actor TEXT NOT NULL, request TEXT NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project, actor, request)
      );
      CREATE TABLE research_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
        subscription TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','quiet','queued','error','cancelled')),
        run TEXT, reason TEXT, at TEXT NOT NULL,
        UNIQUE(project, subscription, event_id)
      );
      CREATE INDEX research_inbox_pending ON research_inbox(state, id);
    `,
  },
  {
    version: 80,
    sql: `ALTER TABLE deploy_intents ADD COLUMN release_manifest_sha256 TEXT
      CHECK(release_manifest_sha256 IS NULL OR (length(release_manifest_sha256)=64 AND release_manifest_sha256 NOT GLOB '*[^0-9a-f]*'));`,
  },
  {
    version: 81,
    sql: `
      ALTER TABLE dev_tickets ADD COLUMN native_binding TEXT CHECK(native_binding IS NULL OR json_valid(native_binding));
      CREATE UNIQUE INDEX dev_native_session ON dev_tickets(
        json_extract(native_binding,'$.owner'),json_extract(native_binding,'$.device'),
        json_extract(native_binding,'$.source'),json_extract(native_binding,'$.sessionId')) WHERE native_binding IS NOT NULL;
      CREATE TABLE dev_native_inputs(id TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
        message_id INTEGER REFERENCES ticket_messages(id), state TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX dev_native_inputs_ticket ON dev_native_inputs(ticket_id);
    `,
  },
  {
    version: 82,
    sql: `CREATE TABLE cli_release_projections (
      commit_sha TEXT PRIMARY KEY CHECK(length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
      ticket_id INTEGER NOT NULL REFERENCES dev_tickets(id),
      projected_at TEXT NOT NULL
    );`,
  },
  {
    version: 83,
    sql: `
      -- Preserve each owed revision when a newer landing updates the summary.
      -- Keep the existing table writable by retained pre-v83 rollback releases.
      CREATE TABLE app_release_pending_revisions (
        app_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
        ticket_id INTEGER, requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY(app_id, commit_sha)
      );
      INSERT INTO app_release_pending_revisions
        SELECT app_id, commit_sha, ticket_id, requested_by, requested_at, reason
        FROM app_release_pending;
      CREATE TRIGGER app_release_pending_insert AFTER INSERT ON app_release_pending BEGIN
        INSERT INTO app_release_pending_revisions VALUES
          (NEW.app_id, NEW.commit_sha, NEW.ticket_id, NEW.requested_by, NEW.requested_at, NEW.reason)
        ON CONFLICT(app_id, commit_sha) DO UPDATE SET
          ticket_id=excluded.ticket_id, requested_by=excluded.requested_by,
          requested_at=excluded.requested_at, reason=excluded.reason;
      END;
      CREATE TRIGGER app_release_pending_update AFTER UPDATE ON app_release_pending BEGIN
        INSERT INTO app_release_pending_revisions VALUES
          (NEW.app_id, NEW.commit_sha, NEW.ticket_id, NEW.requested_by, NEW.requested_at, NEW.reason)
        ON CONFLICT(app_id, commit_sha) DO UPDATE SET
          ticket_id=excluded.ticket_id, requested_by=excluded.requested_by,
          requested_at=excluded.requested_at, reason=excluded.reason;
      END;
      -- Old binaries clear only after publishing their newest summary commit.
      CREATE TRIGGER app_release_pending_delete AFTER DELETE ON app_release_pending BEGIN
        DELETE FROM app_release_pending_revisions WHERE app_id = OLD.app_id;
      END;
    `,
  },
  {
    version: 84,
    sql: `
      -- Runners replay recent completion receipts after every reconnect. One
      -- row per receipt that already produced its owner notice; rows older
      -- than the notice window are pruned on write. Owner/device carry no FK:
      -- a removed device's rows simply age out with the window.
      CREATE TABLE managed_completion_notices (
        owner TEXT NOT NULL,
        device TEXT NOT NULL,
        provider TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (owner, device, provider, turn_id)
      );
      CREATE INDEX managed_completion_notices_age ON managed_completion_notices(completed_at);
    `,
  },
  {
    version: 85,
    sql: `
      -- B5: a member the instance creator removed cannot seat themselves again
      -- with the same share link (the link is the bare instance key). Only the
      -- creator's member management re-adds them, which clears this row.
      CREATE TABLE app_shared_removals (
        app_id TEXT NOT NULL,
        instance_key TEXT NOT NULL,
        username TEXT NOT NULL,
        removed_at TEXT NOT NULL,
        PRIMARY KEY (app_id, instance_key, username)
      );
    `,
  },
  {
    version: 86,
    sql: `
      -- Review 6.10: record how each NEW ticket and ticket message was written,
      -- from the credential the write arrived on, so an agent holding a user's
      -- key no longer looks like that user typing in the browser.
      --   browser = a named user's live browser session (cookie + session row)
      --   token   = a dashboard/API bearer (scripts, agents using a user's key)
      --   mcp     = an MCP credential
      --   system  = written by the Head itself (CI repair, review batches,
      --             CLI report projections, pipeline notes, agent replies)
      --   feishu  = reserved for a Feishu inbox entry (none writes today)
      -- NULL = written before v86: unknown, never guessed or backfilled.
      ALTER TABLE dev_tickets ADD COLUMN actor_kind TEXT
        CHECK(actor_kind IS NULL OR actor_kind IN ('browser','token','mcp','system','feishu'));
      ALTER TABLE ticket_messages ADD COLUMN actor_kind TEXT
        CHECK(actor_kind IS NULL OR actor_kind IN ('browser','token','mcp','system','feishu'));
    `,
  },
  {
    version: 87,
    sql: `
      -- Feishu Docs Agent cards: one row per card that shows one session
      -- read-only to the document's readers in the configured tenant. The card
      -- keeps the capability in its document Record; only its SHA-256 is the
      -- key here. Input never comes from a row: it needs the owner's own login.
      -- Owner/resource carry no FK: the resource is an opaque Session Hub id
      -- whose device and session live outside this database.
      CREATE TABLE feishu_docs_shares (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        resource TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX feishu_docs_shares_owner ON feishu_docs_shares(owner, resource);
    `,
  },
  {
    version: 88,
    sql: `
      -- Read access to one registered Runner workspace, granted by its owner to
      -- named Octopus accounts. A row is the owner's standing decision that the
      -- grantee may read files inside that workspace on that device; the Runner
      -- still confines every read to the workspace's real path. Write access is
      -- not expressible here.
      CREATE TABLE workspace_grants (
        owner TEXT NOT NULL,
        device TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        grantee TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner, device, workspace_id, grantee)
      );
      CREATE INDEX workspace_grants_grantee ON workspace_grants(grantee);
    `,
  },
  {
    version: 89,
    sql: `
      -- Feishu Docs boards: a visual card an owner's agent publishes into a
      -- document as static HTML and may update in place. The id is the handle
      -- the owner's agents update it by; the card's Record keeps a separate
      -- capability, of which only the SHA-256 is stored here. Any signed-in
      -- tenant reader holding the capability may read the board; only the
      -- owner's agents change it, and only the owner revokes it.
      CREATE TABLE feishu_docs_boards (
        id TEXT PRIMARY KEY,
        capability TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        html TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX feishu_docs_boards_owner ON feishu_docs_boards(owner);
    `,
  },
  {
    version: 90,
    sql: `
      -- The newest agent reply the owner has seen in a Feishu Docs card, as the
      -- reply's own timestamp. Kept on every card of the same session, so a
      -- reply read in one card is read in all of them. NULL = never read there.
      ALTER TABLE feishu_docs_shares ADD COLUMN read_at TEXT;
    `,
  },
  {
    version: 91,
    sql: `
      -- A Feishu Docs card is either live (follows its session) or a snapshot:
      -- the conversation frozen at one completed turn. A snapshot keeps the
      -- rows it showed and the provider's anchor for that turn (JSON
      -- {anchor, at, rows}), so it reads without the device and a later fork
      -- starts exactly there. origin (JSON {kind, from, by, at}) says how a
      -- snapshot or a fork's card came to be.
      ALTER TABLE feishu_docs_shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'live';
      ALTER TABLE feishu_docs_shares ADD COLUMN snapshot TEXT;
      ALTER TABLE feishu_docs_shares ADD COLUMN origin TEXT;
      -- Members an owner lets talk to one of their agents in its cards: send,
      -- stop and fork. Their messages carry their name; the agent still runs
      -- on the owner's device as the owner's agent.
      CREATE TABLE feishu_docs_speakers (
        owner TEXT NOT NULL,
        resource TEXT NOT NULL,
        member TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner, resource, member)
      );
    `,
  },
  {
    version: 92,
    sql: `
      -- A Knowledge Chat answer is stored whole. v61 bounded every message at
      -- 8,000 characters and the service cut answers to fit, so a long answer
      -- lost its tail without saying so. The question's own bound stays in the
      -- route schema; the column only requires a non-empty message. SQLite
      -- cannot alter a CHECK, so the table is rebuilt with ids, request ids,
      -- the cascade and the AUTOINCREMENT high-water mark preserved.
      CREATE TABLE knowledge_chat_messages_v92 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES knowledge_chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'error')),
        content TEXT NOT NULL CHECK(length(content) >= 1),
        request_id TEXT CHECK(request_id IS NULL OR length(request_id) BETWEEN 8 AND 80),
        at TEXT NOT NULL,
        UNIQUE(chat_id, request_id)
      );
      INSERT INTO knowledge_chat_messages_v92 (id, chat_id, role, content, request_id, at)
        SELECT id, chat_id, role, content, request_id, at FROM knowledge_chat_messages;
      DELETE FROM sqlite_sequence WHERE name = 'knowledge_chat_messages_v92';
      INSERT INTO sqlite_sequence (name, seq)
        SELECT 'knowledge_chat_messages_v92', seq FROM sqlite_sequence WHERE name = 'knowledge_chat_messages';
      DROP TABLE knowledge_chat_messages;
      ALTER TABLE knowledge_chat_messages_v92 RENAME TO knowledge_chat_messages;
      CREATE INDEX idx_knowledge_chat_messages
        ON knowledge_chat_messages(chat_id, id);
    `,
  },
  {
    version: 93,
    sql: `
      -- Feishu document share links: an owner lets one collaborator's agent
      -- read, or read and write, ONE docx through /api/mcp as the Octopus
      -- Feishu app. A share works only while its anchor — an Octopus control
      -- card in that same document — is there. The card's Record keeps the
      -- anchor capability; only its SHA-256 is stored. Presence is checked
      -- lazily: lease_until (ms) is when the last sighting stops vouching for
      -- the card. state 'unknown' = an insert whose outcome Feishu never
      -- reported; a later check settles it. document_id and wiki_token are the
      -- document's canonical identity, fixed when the card is made: its docx
      -- id, and the wiki node holding it when it lives in a wiki. Feishu's
      -- permission checks name the document by exactly this, never by what a
      -- caller passed.
      CREATE TABLE feishu_doc_share_anchors (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        document_id TEXT NOT NULL,
        wiki_token TEXT,
        capability_hash TEXT NOT NULL UNIQUE,
        block_id TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('present', 'missing', 'unknown')),
        created_at INTEGER NOT NULL,
        checked_at INTEGER
      );
      CREATE INDEX feishu_doc_share_anchors_owner ON feishu_doc_share_anchors(owner, document_id, created_at);
      -- A share is created 'pending', with no token. The owner, signed in on
      -- the control card, reveals it once: its MCP token is minted then
      -- (mcp_token_hash, the same sha256 mcp_tokens keys on) and it turns
      -- 'active' in the same transaction. No FK to mcp_tokens or users: a
      -- token row is revoked by the token list and deleted with its account
      -- on their own lifecycles, and the share then reads as terminated.
      -- document_id repeats the anchor's: it is the trusted closure every
      -- call runs against.
      CREATE TABLE feishu_doc_shares (
        id TEXT PRIMARY KEY,
        anchor_id TEXT NOT NULL REFERENCES feishu_doc_share_anchors(id),
        owner TEXT NOT NULL,
        document_id TEXT NOT NULL,
        label TEXT NOT NULL,
        rights TEXT NOT NULL CHECK(rights IN ('read', 'write')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'paused', 'terminated')),
        mcp_token_hash TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        status_changed_at INTEGER NOT NULL,
        -- Pending has no token; active and paused have one.
        CHECK ((status = 'pending' AND mcp_token_hash IS NULL)
          OR (status IN ('active', 'paused') AND mcp_token_hash IS NOT NULL)
          OR status = 'terminated')
      );
      CREATE INDEX feishu_doc_shares_anchor ON feishu_doc_shares(anchor_id, created_at);
      CREATE INDEX feishu_doc_shares_owner ON feishu_doc_shares(owner, document_id, created_at);
      -- Terminated is final, and nothing goes back to pending: a share is
      -- revealed at most once.
      CREATE TRIGGER feishu_doc_shares_terminated_final
        BEFORE UPDATE OF status ON feishu_doc_shares
        WHEN OLD.status = 'terminated' AND NEW.status <> 'terminated'
      BEGIN
        SELECT RAISE(ABORT, 'a terminated Feishu document share is final');
      END;
      CREATE TRIGGER feishu_doc_shares_revealed_once
        BEFORE UPDATE OF status ON feishu_doc_shares
        WHEN NEW.status = 'pending' AND OLD.status <> 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'a Feishu document share is revealed only once');
      END;
    `,
  },
  {
    version: 94,
    sql: `
      -- Self-served access keys: whoever can read a control card may take a
      -- key for themselves, up to the most its owner allows. self_serve 'off'
      -- = only the owner makes keys; 'write' is the default, the case being a
      -- collaborator who edits the document. A claim link carries the same
      -- power to someone who cannot see the card: only its SHA-256 is kept
      -- (invite_hash, and when it was made). Making a new one replaces it, so
      -- the old link stops at once; clearing it stops it. A hash names at
      -- most one card.
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN self_serve TEXT NOT NULL DEFAULT 'write'
        CHECK(self_serve IN ('off', 'read', 'write'));
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN invite_hash TEXT;
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN invite_created_at INTEGER;
      CREATE UNIQUE INDEX feishu_doc_share_anchors_invite ON feishu_doc_share_anchors(invite_hash)
        WHERE invite_hash IS NOT NULL;
      -- How a key was made: 'owner' (the owner's agent created it pending and
      -- the owner took it on the card), 'card' (a reader took it there),
      -- 'invite' (through the claim link), or 'assistant' (reserved for the
      -- owner-hosted document assistants that follow; nothing writes it yet).
      -- A reader's key is inserted active with its token in one transaction:
      -- it is never pending, so the owner's reveal never applies to it.
      -- minted_by is the Feishu open_id of a signed-in tenant reader who took
      -- it, NULL otherwise: it marks a reader's own keys and authorizes
      -- nothing.
      ALTER TABLE feishu_doc_shares ADD COLUMN via TEXT NOT NULL DEFAULT 'owner'
        CHECK(via IN ('owner', 'card', 'invite', 'assistant') AND (via NOT IN ('card', 'invite') OR status <> 'pending'));
      ALTER TABLE feishu_doc_shares ADD COLUMN minted_by TEXT;
    `,
  },
  {
    version: 95,
    sql: `
      -- Feishu document assistants. A control card's owner links the document
      -- to one registered workspace of theirs (the project, read-only for
      -- everything that uses it) and sets what assistants may do to the
      -- document: assistant_rights NULL = assistants off. The project binding
      -- stands on its own; assistant_rights does not require it to change.
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN project_device TEXT;
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN project_workspace TEXT CHECK(project_workspace IS NULL OR (
        length(project_workspace) = 27 AND substr(project_workspace, 1, 3) = 'ws_'
        AND substr(project_workspace, 4) NOT GLOB '*[^0-9a-f]*'));
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN project_label TEXT;
      ALTER TABLE feishu_doc_share_anchors ADD COLUMN assistant_rights TEXT
        CHECK(assistant_rights IS NULL OR assistant_rights IN ('read', 'write'));

      -- The bearer-free binding of a read-only (document assistant) session
      -- scope: the twin of session_execution_bindings (v58 + v67), kept in its
      -- own table because a binary that predates the profile reads only the
      -- old one and would rebuild a row as a full scope. Placement here is
      -- always one device, owner-local, Claude.
      CREATE TABLE session_execution_read_only_bindings (
        owner TEXT NOT NULL,
        runtime_owner TEXT NOT NULL,
        runtime_device TEXT NOT NULL,
        runtime_resource_id TEXT CHECK(runtime_resource_id IS NULL),
        source TEXT NOT NULL CHECK(source = 'claude'),
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        execution_device TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        permission_profile TEXT NOT NULL CHECK(permission_profile = 'read_only'),
        doc_share_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(runtime_owner = owner AND runtime_device = execution_device),
        PRIMARY KEY(owner, runtime_device, source, session_id)
      );
      CREATE INDEX idx_session_execution_read_only_bindings_expiry
        ON session_execution_read_only_bindings(expires_at);

      -- One document assistant: a tenant member (guest_open_id, verified by
      -- the add-on login; guest_name is display only) runs their own agent on
      -- the anchor owner's device, as the owner's session. id is the launch's
      -- client_request_id: the dispatch preparer issues a read-only scope only
      -- for an id registered here, not ended and not yet bound to a session.
      -- share_id is its via='assistant' document share. ended_at is final;
      -- error says why a launch failed; pinned_at is when the guest put its
      -- card into the document (from then on any reader may watch it).
      CREATE TABLE feishu_doc_assistants (
        id TEXT PRIMARY KEY CHECK(length(id) = 47 AND substr(id, 1, 7) = 'op_fda_'),
        owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        anchor_id TEXT NOT NULL REFERENCES feishu_doc_share_anchors(id),
        share_id TEXT NOT NULL UNIQUE REFERENCES feishu_doc_shares(id),
        guest_open_id TEXT NOT NULL,
        guest_name TEXT NOT NULL,
        title TEXT NOT NULL,
        device TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        pinned_at INTEGER,
        ended_at INTEGER,
        error TEXT,
        UNIQUE(owner, device, session_id)
      );
      CREATE INDEX feishu_doc_assistants_anchor ON feishu_doc_assistants(anchor_id, ended_at);
      CREATE INDEX feishu_doc_assistants_guest ON feishu_doc_assistants(anchor_id, guest_open_id, ended_at);
      CREATE INDEX feishu_doc_assistants_starts ON feishu_doc_assistants(guest_open_id, created_at);
      CREATE TRIGGER feishu_doc_assistants_ended_final
        BEFORE UPDATE OF ended_at ON feishu_doc_assistants
        WHEN OLD.ended_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'an ended Feishu document assistant is final');
      END;
    `,
  },
  {
    version: 96,
    sql: `
      -- Guest client devices (2026-11-12). A friend's PC enrolled under the
      -- owner runs its own Claude Code / Codex; the only thing it may ask of
      -- Octopus is a byte tunnel to model_host's model egress, which injects
      -- the owner's model login there. The row is server-side truth: the guest
      -- Runner cannot widen providers or pick another host, and the gateway
      -- refuses its bridge, session and recovery traffic.
      CREATE TABLE runner_guest_profiles (
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        device TEXT NOT NULL CHECK(length(device) BETWEEN 1 AND 32),
        model_host TEXT NOT NULL CHECK(length(model_host) BETWEEN 1 AND 128),
        providers TEXT NOT NULL CHECK(providers IN ('anthropic', 'openai', 'anthropic,openai')),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY(username, device)
      );
    `,
  },
];
