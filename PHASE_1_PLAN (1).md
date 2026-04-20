# Phase 1 — Hermes-Native Multi-Tenant Email-to-Trello-to-Slack-Approved Reply

This document is the complete plan for Phase 1. It contains:

- Part A: the architecture — what the system is, how Hermes fits, where the safety boundaries are.
- Part B: step-by-step implementation (the "how"), strict order, not to be skipped.

When working on this project, always keep this document in context. Build strictly step by step — do not implement later steps early. Do not add features, tools, MCP servers, or skills beyond what each step explicitly calls for.

---

# Part A — The System

## Goal

A Hermes-based system that handles client email intake for multiple teams, each running multiple projects. Each project has its own Gmail inbox, Trello board, and Slack channel. For any project, the system:

1. Polls email on a schedule.
2. Extracts structured requirements from incoming client emails.
3. Creates a Trello card with full context.
4. Drafts a professional "work in progress" reply.
5. Posts both the extracted requirements and the drafted reply to Slack for human review.
6. On Slack approval, sends the reply from that project's inbox. On rejection or edit, behaves accordingly.
7. Learns from human edits over time — improving per-project extraction and drafting skills.

No email is ever sent to a client without explicit human approval. This is enforced mechanically, not by prompting.

## Scale

- Max ~10 teams, ~20 projects total.
- Emails are about dev work: feature requests, bug fixes, change requests, clarifications.
- Volume: low to moderate, under 100 emails/day total.

## Non-goals

- No code changes, PRs, or repo access (Phase 2).
- No auto-reply without human approval. Ever.
- No web UI. Slack is the UI. A CLI handles team/project setup.
- No billing, quotas, or usage tracking.
- No cross-project data leakage.

## Why Hermes (not a plain Node service)

Hermes gives us four things that a custom service does not, for free:

- **A persistent agent with skill and memory accumulation.** Per-project skills that improve when humans correct the agent.
- **Built-in cron scheduling** with delivery to any connected platform.
- **MCP client support** for wiring Gmail, Trello, Slack, and Firestore as tool servers.
- **Hooks** (`pre_llm_call`, `post_llm_call`, `on_session_end`) for logging and feedback-loop triggers.

The cost of using Hermes is that it is an agent — it reasons, and agents can reason wrongly. We offset that cost by making the dangerous parts mechanical: routing, approval gates, tenant isolation.

## Hermes runtime topology

One VPS runs:

- **One Hermes instance** (the main agent). Uses Hermes's profile system to stay isolated if needed.
- **Several MCP servers** (local subprocesses or local HTTP): `gmail-mcp`, `trello-mcp`, `slack-mcp`, `firestore-mcp`. Each is a thin wrapper that exposes project-scoped tools.
- **A small "guardrail" HTTP service** (Node/Express) that handles the only things Hermes is *not* allowed to do directly: (a) issue an approval token after a Slack button click, (b) receive Slack interactive events, (c) serve as the single place the `send_email` tool checks an approval before executing.
- **Firestore** for all state: teams, projects, email threads, approval tokens, audit log.
- **Cloudflare Tunnel** for the Slack webhook.

```
              +--------------------------+
              |     Hermes Agent         |
              |  - cron: poll_inboxes    |
              |  - skills: per-project   |
              |  - memory: per-client    |
              |  - hooks: audit + learn  |
              +---+-----+-----+------+---+
                  |     |     |      |
     MCP tools:   |     |     |      |
     +------------+     |     |      +------------+
     v                  v     v                   v
  gmail-mcp        trello-mcp  slack-mcp    firestore-mcp
     |                  |         |               |
     v                  v         v               v
   Gmail            Trello     Slack         Firestore
                     API        API        (state + audit)
                                ^
                                |
                 +--------------+--------------+
                 |  Guardrail Service (Node)   |
                 |  - /slack/events webhook    |
                 |  - /approval/token (issue)  |
                 |  - /approval/check (verify) |
                 +-----------------------------+
```

Critical: Hermes calls `send_email(approvalToken, ...)`. The `send_email` tool (inside `gmail-mcp`) refuses to execute without a valid, unused, non-expired approval token. Approval tokens are minted only by the guardrail service, only in response to a verified Slack button click. **This is the safety gate. It is not a prompt. It is code.**

## State machine (per email thread)

```
received -> extracted -> carded -> drafted -> awaiting_approval
                                              |
                                              +-> approved -> sent
                                              +-> rejected -> closed
                                              +-> edited -> awaiting_approval (again)
```

Each thread doc in Firestore carries `teamId` and `projectId`. Every state transition is written to `stateHistory` with timestamp, actor (`hermes` or `user:Uxxx`), and source step.

## Data model

### `teams/{teamId}`

```
{
  id, name, active, createdAt, updatedAt
}
```

### `projects/{projectId}`

```
{
  id, teamId, name, clientName, active, createdAt, updatedAt,

  gmail: {
    inboxEmail,
    clientIdEncrypted,
    clientSecretEncrypted,
    refreshTokenEncrypted,
    watchLabel,              // "INBOX" or custom
  },
  trello: {
    apiKeyEncrypted,
    tokenEncrypted,
    boardId,
    inboxListId,
  },
  slack: {
    botTokenEncrypted,
    channelId,
    workspaceId,
  },
  prompts: {
    extractionAddendum,      // project-specific static context
    replySignature,
    replyToneNotes,
  },
  skills: {
    extraction: "skills/projects/{projectId}/extraction.md",  // path in Hermes skills dir
    drafting:   "skills/projects/{projectId}/drafting.md",
  },
  lastPolledAt, lastPollError
}
```

### `emailThreads/{id}`

```
{
  id,                                   // "{projectId}__{gmailThreadId}"
  teamId, projectId,
  gmailThreadId,
  clientEmail, clientName, subject,
  firstReceivedAt, lastMessageAt,
  rawEmail, rawEmailHistory[],
  lastMessageIdHeader,                  // for In-Reply-To threading

  state: received | extracted | carded | drafted | awaiting_approval
       | approved | sent | rejected | closed | edited,
  stateHistory: [{ state, at, by, step }],

  extraction: {
    summary,
    changeType: new_feature | modification | bug_fix | removal | clarification | not_a_requirement,
    requirements[], affectedAreas[], openQuestions[], outOfScope[], acceptanceCriteria[]
  },

  trelloCardId, trelloCardUrl,
  draftedReply, editedReply, sentReply,
  slackMessageTs, slackChannelId, approvedBy,
  errors: [{ at, step, message }]
}
```

### `approvalTokens/{tokenId}`

```
{
  id,                      // random UUID, this is the token
  threadId, projectId,
  kind: "send_reply",
  payloadHash,             // hash of (threadId + exact reply text) — binds token to specific content
  issuedAt, expiresAt,     // e.g. 10-minute expiry
  used: bool,
  usedAt, usedBy
}
```

### `auditLog/{id}`

Append-only log of every Hermes action: tool call, hook fire, skill update. Used for debugging and post-mortem.

```
{
  at, projectId?, threadId?,
  kind: tool_call | hook | skill_update | approval_issued | approval_consumed,
  tool?, input, output, durationMs,
  sessionId, hermesTurnId
}
```

### Firestore indexes

- `emailThreads` where `projectId == X and state == Y`.
- `projects` where `active == true`.
- `approvalTokens` where `threadId == X and used == false`.

### Firestore security rules

Lock all collections to the service account only. No client SDK access.

## Tools exposed to Hermes (and the ones that are NOT)

Hermes agentically calls MCP tools. **Tool definitions are the trust boundary, not the prompt.**

### `firestore-mcp` (project-scoped)

- `get_project(projectId)`
- `get_thread(threadId)`
- `list_threads_by_state(projectId, state)` — only returns threads matching `projectId`.
- `update_thread(threadId, patch, expectedState?)` — enforces `expectedState` for optimistic concurrency; refuses to cross `projectId` boundaries; refuses to set state directly to `sent` (only the internal send path does that).
- `append_state_history(threadId, state, by, step)`
- `append_error(threadId, step, message)`
- `log_audit(kind, payload)`

### `gmail-mcp` (per-project credentials, resolved by projectId param)

- `list_new_emails(projectId)` — returns parsed unread messages from that project's inbox; marks them read.
- `fetch_message(projectId, gmailMessageId)` — if needed for followups.
- `send_reply(projectId, threadId, replyText, approvalToken)` — **refuses without a valid, unused, non-expired approval token whose `payloadHash` matches hash(threadId + replyText)**. This is the hard gate.

### `trello-mcp`

- `create_card(projectId, title, description, checklist[])` — refuses if `projectId` is unknown or inactive.
- `add_card_comment(cardId, text)`
- `get_card(cardId)`

### `slack-mcp`

- `post_approval_message(projectId, threadId, blocks)` — posts to the project's configured channel; returns `ts`. Embeds `projectId` and `threadId` in all button values.
- `update_message(projectId, channelId, ts, blocks)` — e.g. to mark as approved/rejected.
- `open_modal(...)` — for the edit flow.
- Hermes cannot post to arbitrary Slack channels. `slack-mcp` only posts to channels registered in `projects/{projectId}`.

### Guardrail service (HTTP, not an MCP tool — intentionally)

- `POST /slack/events` — receives Slack interactions, verifies signing secret, parses `{ projectId, threadId, action }` from the button `value`, and either:
  - (approve) mints an approval token in Firestore for `(threadId, draftedReply_or_editedReply)` and then *notifies Hermes* by writing a signal doc (`approvalSignals/{threadId}`) that a Hermes cron or a simple `wait_for_approval_signal` tool polls. Hermes picks up the signal, reads the token, calls `send_reply` with it.
  - (reject) marks the thread `rejected`, updates the Slack message, notifies Hermes via the same signal mechanism.
  - (edit) opens the modal, then on submit saves `editedReply` and re-posts approval. Token is not issued until re-approved.
- `GET /health`

**The guardrail service never trusts Hermes** — the agent cannot mint its own approval tokens, cannot bypass Slack verification, cannot send mail directly. If Hermes is compromised or hallucinates wildly, the worst it can do is create Trello cards and post Slack drafts. That is an acceptable blast radius.

## Determinism where it matters

Rules that are enforced as code, not prompt:

1. **Project routing is by inbox, not by agent reasoning.** `list_new_emails(projectId)` tags every returned email with that projectId. Hermes never "figures out" which project an email belongs to.
2. **Approval tokens bind to exact content.** `payloadHash = hash(threadId + replyText)`. If Hermes changes even one character of the reply between approval and send, the hash mismatches and `send_reply` refuses. Humans see the exact text they are approving.
3. **One approval = one send.** Tokens have `used: bool`. `send_reply` atomically sets `used = true`; double-spend is impossible.
4. **Tool-level project scoping.** Every MCP tool takes `projectId` and validates it against the `projects` collection. Cross-project calls fail at the tool layer.
5. **Audit log is append-only.** Every tool call gets logged before and after. Post-mortems are always possible.

## Skills (the learning layer)

Two kinds:

### Global skills (seeded by us, manually maintained)

Live in `~/.hermes/skills/global/`. Examples:

- `intake-workflow.md` — the top-level procedure: "when you see a new email, do X, Y, Z, never do W".
- `approval-protocol.md` — "you cannot send email without an approval token from the guardrail service; do not try to bypass this".
- `tenant-isolation.md` — "always pass projectId explicitly; never assume a thread belongs to any project other than what list_new_emails gave you".
- `state-machine.md` — the states and allowed transitions.

### Per-project skills (seeded empty, grown by the feedback loop)

Live in `~/.hermes/skills/projects/{projectId}/`:

- `extraction.md` — starts with just the project's `extractionAddendum`. Grows with learnings like "for Acme Corp, 'invoice' means billing statement, not sent invoice" when humans edit extractions.
- `drafting.md` — starts with signature and tone notes. Grows with learnings about how each client likes to be addressed, recurring phrases, etc.
- `clients/{clientEmail}.md` — optional, created only when Hermes notices something worth remembering about a specific sender.

### The feedback loop

When a human edits the extraction on a Trello card OR edits the drafted reply in Slack, a hook fires:

1. The Firestore `update_thread` call records the "before" and "after" content.
2. A post-processing step (triggered by `on_session_end` or a scheduled cron) asks Hermes: "Here is what you extracted/drafted. Here is what the human changed it to. If there is a generalizable lesson, update the relevant project skill. If the edit is a one-off, do nothing."
3. Skill edits are written to disk and logged to `auditLog`.
4. A "skill review queue" (just a Firestore collection) accumulates recent skill edits. Every Friday, a human reviews them and either keeps, edits, or reverts them.

The feedback loop is gated behind a config flag (`learning.enabled`) that defaults to false in early deployment. Turn on after the base flow is stable.

## Multi-tenancy enforcement

Every tool call is tagged with `projectId`. Every Firestore doc carries `projectId`. Every Slack button value carries `projectId`. Every skill file lives under `skills/projects/{projectId}/`.

Cross-project leak prevention checklist (to verify before go-live):

- [ ] No global mutable state in Hermes skills that references one project's data.
- [ ] `firestore-mcp` rejects any operation where computed `projectId` from thread ID prefix mismatches the `projectId` param.
- [ ] `gmail-mcp` refuses to send from a different inbox than the `projectId`'s configured inbox.
- [ ] `slack-mcp` refuses to post to a channel other than the `projectId`'s configured channel.
- [ ] Approval tokens cannot be used across threads (token's `threadId` is enforced at consumption).
- [ ] Audit log reveals any cross-tenant attempts.

## What NOT to rely on Hermes reasoning for

Prompts can fail. These are code-enforced, not prompt-requested:

- "Do not send email without approval." — enforced by approval token gate.
- "Do not cross projects." — enforced by tool-level projectId validation.
- "Do not modify state to sent without actually sending." — enforced by `firestore-mcp` refusing direct `state = sent` updates.
- "Always log." — enforced by MCP wrappers calling `log_audit` on every action.

## Success criteria

Phase 1 is done when:

- At least 2 projects across 2 teams running.
- 10 consecutive client emails flow end-to-end without intervention beyond Slack approval.
- Zero emails sent without approval.
- Zero cross-project leaks over 2 weeks of operation.
- Adding a new project takes under 15 minutes.
- Extracted Trello cards are readable without the original email.
- The audit log can reconstruct any single email's full processing history.

Once stable for two weeks, turn on `learning.enabled` and run for another two weeks. Then plan Phase 2.

---

# Part B — Implementation Steps

Build strictly in order. After each step, the user verifies it works before moving on. Each step has an explicit "do NOT" list; obey it.

Language choices:
- **MCP servers**: Node.js + TypeScript (consistent with your stack).
- **Guardrail service**: Node.js + Express + TypeScript.
- **Hermes**: Python (it is what it is). Skills are markdown.
- **Admin CLI**: Node.js + TypeScript.

Repo layout (final target):

```
lab3-intake/
├── hermes/                          # Hermes config + skills (not the agent itself; that's installed separately)
│   ├── config.yaml                  # Hermes main config
│   ├── skills/
│   │   ├── global/
│   │   │   ├── intake-workflow.md
│   │   │   ├── approval-protocol.md
│   │   │   ├── tenant-isolation.md
│   │   │   └── state-machine.md
│   │   └── projects/                # per-project, created by admin CLI
│   └── hooks/
│       ├── pre_llm_call.py
│       ├── post_llm_call.py
│       └── on_session_end.py
│
├── mcp-servers/
│   ├── firestore-mcp/               # Node MCP server
│   ├── gmail-mcp/
│   ├── trello-mcp/
│   └── slack-mcp/
│
├── guardrail/                       # Node Express service for Slack webhook + approval tokens
│   └── src/
│
├── admin/                           # Node CLI for team/project onboarding
│   └── src/
│
├── shared/                          # types, crypto, firestore client, logger — shared by MCPs/guardrail/admin
│   └── src/
│
├── .env.example
├── package.json                     # root package.json with workspaces
└── README.md
```

Use npm workspaces so `shared/` can be imported by MCPs, guardrail, and admin without publishing.

---

## Step 1 — Repo skeleton + `shared` package

**Goal:** npm workspaces monorepo. `shared` has env loading, Firestore client, AES-GCM crypto, and a structured logger. Nothing else runs yet.

**Actions:**

- Root `package.json` with `"workspaces": ["shared", "mcp-servers/*", "guardrail", "admin"]`.
- Root `tsconfig.base.json` with strict settings.
- Create `shared/` with `package.json`, its own `tsconfig.json extends tsconfig.base.json`.
- In `shared/src/`:
  - `config.ts` — loads global env vars with zod. Required: `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `ENCRYPTION_KEY`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY` (for any step that needs it; not used in step 1), `GUARDRAIL_PORT`.
  - `firestore.ts` — initializes firebase-admin, exports Firestore instance and common helpers (`now()`, `collection refs`).
  - `crypto.ts` — AES-GCM `encrypt(plaintext) -> base64` and `decrypt(base64) -> plaintext`. Random IV per call. Format: base64(iv || ciphertext || authTag).
  - `logger.ts` — JSON logger honoring `LOG_LEVEL`. Always includes `timestamp` and `service` (passed in at logger creation). Supports `info`/`warn`/`error`/`debug`.
  - `types.ts` — TypeScript types for Team, Project, EmailThread, ApprovalToken, AuditLog as in Part A. Export from index.
  - `index.ts` — re-exports the above.
- `.env.example` with the vars listed.
- `.gitignore` for `node_modules`, `dist`, `.env`, service account JSON, `*.log`.

**Verification:**
- Write a one-off script at `shared/test/smoke.ts`:
  - Load config.
  - Write a doc to `_healthcheck/ping` in Firestore.
  - Call `encrypt("hello")` then `decrypt(...)`; assert roundtrip.
  - Log a test entry.
- Run `ts-node shared/test/smoke.ts`. Confirm success. Delete the smoke test when verified.

**Do NOT in Step 1:**
- Do not start on MCP servers, guardrail, or admin CLI.
- Do not install Hermes yet.
- Do not write a single tool yet.

---

## Step 2 — Team + Project repositories + Admin CLI (dry, without external validation)

**Goal:** CLI to create teams and projects. Secrets encrypted at rest. External services (Gmail/Trello/Slack) are NOT contacted yet — values are pasted in manually. Real OAuth and validation come in later steps when those integrations are built.

**Actions:**

- `admin/src/repos/teams.ts` — `createTeam`, `getTeam`, `listTeams`, `setActive`.
- `admin/src/repos/projects.ts` — `createProject` (accepts plaintext secrets, encrypts before writing), `getProject`, `listActiveProjects`, `setActive`, `updateSecret`.
- `admin/src/cli.ts` — dispatch on argv. Subcommands:
  - `add-team` — prompts for `id`, `name`.
  - `add-project` — prompts for:
    - `id`, `name`, `teamId` (validates team exists), `clientName`
    - Gmail: inboxEmail, clientId, clientSecret, refreshToken (paste-in for now)
    - Trello: apiKey, token, boardId, inboxListId
    - Slack: botToken, channelId, workspaceId
    - Prompts: extractionAddendum (multi-line), replySignature, replyToneNotes
    - Writes the project doc with `active: true` and seeds skill file paths.
  - `list-projects`
  - `disable-project <id>`
- Root `package.json`: `"admin": "ts-node admin/src/cli.ts"`.

**Verification:**
- `npm run admin -- add-team --id test-team --name "Test Team"` works.
- `npm run admin -- add-project` (interactive) walks through fields; dummy values accepted.
- `npm run admin -- list-projects` shows the record.
- In Firestore console, secret fields are base64 ciphertext.
- Loading the project back and decrypting yields the original values.

**Do NOT in Step 2:**
- No OAuth flow. No Trello or Slack API calls. No Gmail API calls. Those come in the steps that need them.
- No Hermes yet.

---

## Step 3 — `firestore-mcp` server

**Goal:** Working MCP server exposing the Firestore tools from Part A. Can be tested standalone with `mcp-inspector` or curl-equivalent without Hermes involved.

**Actions:**

- `mcp-servers/firestore-mcp/` — Node MCP server using `@modelcontextprotocol/sdk` (stdio transport).
- Tools to expose:
  - `get_project(projectId)` — returns project metadata with secrets redacted (never return encrypted or decrypted secret values in tool output).
  - `get_thread(threadId)` — returns thread doc.
  - `list_threads_by_state(projectId, state)` — returns threads for that project in that state.
  - `update_thread(threadId, patch, expectedState?)`:
    - Refuses if `patch` contains `state: 'sent'` (reserved for the internal send path).
    - Refuses if `patch.projectId` differs from the thread's current `projectId`.
    - If `expectedState` provided, refuses unless current state matches (optimistic concurrency).
    - Auto-appends a `stateHistory` entry if `state` changes.
  - `append_error(threadId, step, message)`
  - `log_audit(kind, payload)` — writes to `auditLog`. Every other tool call internally calls this, but this is also exposed for hook use.
- Every tool validates `projectId` exists and is active (when relevant) and logs to audit.

**Verification:**
- Seed a test thread via a throwaway script.
- Use `mcp-inspector` (or a minimal custom stdio harness) to:
  - Call `get_thread` — returns the seeded doc.
  - Call `update_thread` with `state: 'sent'` — refused with clear error.
  - Call `update_thread` with a valid transition — succeeds, state history appended.
  - Inspect `auditLog` — entries present.
- No cross-project operations possible via `update_thread`.

**Do NOT in Step 3:**
- No Gmail, Trello, Slack MCPs yet.
- No Hermes yet.
- No send_reply, no approval tokens.

---

## Step 4 — `gmail-mcp` server (read path only)

**Goal:** Pull emails from a project's inbox as a Hermes-callable tool. Also the moment we implement real OAuth in the admin CLI.

**Actions:**

- Update `admin/src/cli.ts` `add-project` to replace the "paste refresh token" prompt with a real OAuth flow:
  - Scopes: `gmail.readonly`, `gmail.send`.
  - `access_type: offline`, `prompt: consent` to force refresh token.
  - Prints URL, user consents, pastes auth code back, exchange for tokens.
- `mcp-servers/gmail-mcp/` — tools:
  - `list_new_emails(projectId)`:
    - Loads project, decrypts OAuth fields, builds `google.gmail()` client.
    - Queries unread messages matching `watchLabel`.
    - For each: parses headers, plain-text body (handle multipart), extracts `from` (name + address), `subject`, `date`, `Message-ID` header.
    - Marks message as read in Gmail.
    - Writes/updates the `emailThreads` doc with state `received`, `teamId`, `projectId`, `lastMessageIdHeader`.
    - Updates `projects/{id}.lastPolledAt`. On failure sets `lastPollError` and does not re-throw at tool level — returns an error entry.
    - Returns a list of `{ threadId, summaryLine }` for Hermes to iterate.
  - `fetch_message(projectId, gmailMessageId)` — for followup lookups.
  - `send_reply` — **skeleton only, throws "not implemented: approval token required". Wired in Step 9.**
- The tool calls `log_audit` before and after.

**Verification:**
- Add a real Gmail-based project via `add-project`.
- Send yourself an email from another account.
- Invoke `list_new_emails(projectId)` via `mcp-inspector` or harness.
- Confirm: thread upserted in Firestore with correct fields, Gmail message marked read, audit log entry.
- Call `list_new_emails` again with nothing new — returns empty.
- Break the refresh token manually in Firestore; call the tool — returns a clean error, `lastPollError` populated, does not crash.

**Do NOT in Step 4:**
- Do not wire send_reply.
- Do not build Trello or Slack MCPs.
- Do not involve Hermes.

---

## Step 5 — `trello-mcp` server

**Goal:** Card creation tool callable directly.

**Actions:**

- `mcp-servers/trello-mcp/` — tools:
  - `create_card(projectId, title, description, checklist[])`:
    - Loads project, decrypts Trello creds.
    - POSTs to Trello API to create card in `inboxListId`.
    - Creates checklist "Requirements" with the provided items.
    - Returns `{ cardId, cardUrl }`.
    - Refuses if project is inactive or unknown.
    - Logs to audit.
  - `add_card_comment(cardId, text)`
  - `get_card(cardId)`

**Verification:**
- Invoke `create_card` for a test project. Confirm card appears on the right board's inbox list.
- Confirm description supports markdown.
- Confirm checklist appears with items.

**Do NOT in Step 5:**
- No labels, members, due dates, cover images.
- No Slack yet.

---

## Step 6 — `slack-mcp` server + Guardrail service skeleton

**Goal:** Post Slack messages with approval buttons; guardrail service receives clicks and writes signals to Firestore (but does not yet issue approval tokens — Step 9).

**Actions:**

- `mcp-servers/slack-mcp/` — tools:
  - `post_approval_message(projectId, threadId, extraction, draftedReply, trelloCardUrl)`:
    - Builds Block Kit with the message format from Part A.
    - Three buttons (`approve_reply`, `edit_reply`, `reject_reply`), each with `value = JSON.stringify({ projectId, threadId })`.
    - Posts to `project.slack.channelId`.
    - Writes `slackMessageTs` and `slackChannelId` on the thread.
    - Logs to audit.
  - `update_message(projectId, channelId, ts, blocks)` — for marking approved/rejected later.
  - `open_modal(triggerId, view)` — for edit flow.
- `guardrail/src/` — Express server:
  - `POST /slack/events`:
    - Verifies Slack request signature using `SLACK_SIGNING_SECRET`.
    - Parses the interaction payload.
    - If it's a button click, pulls `{ projectId, threadId, action }` from `value`.
    - For each action, writes a doc to `approvalSignals/{threadId}` with `{ action, userId, at }`. **Does not mint approval tokens yet — Step 9.**
    - Responds 200 to Slack with an immediate ack message ("✅ received, processing...").
  - `GET /health`.
- Wire Cloudflare Tunnel to point at `localhost:${GUARDRAIL_PORT}`. Configure Slack app's Interactivity URL to `https://<tunnel>/slack/events`.

**Verification:**
- Invoke `post_approval_message` directly with a fake extraction + reply for a test project. Message appears in Slack.
- Click each button. Confirm a signal doc is written to `approvalSignals/{threadId}` with the right action and userId.
- Confirm the Slack signature verification works (a request with bad signature is rejected 401).

**Do NOT in Step 6:**
- Do not mint approval tokens.
- Do not send email.
- Do not implement the edit modal's submit handler fully; opening the modal can come in Step 9.
- Do not involve Hermes yet.

---

## Step 7 — Install Hermes, wire MCP servers, seed global skills

**Goal:** Hermes is installed and can see all four MCP servers as tools. Global skills loaded. Can have a chat conversation that lists threads and creates cards, but does not yet drive the full workflow.

**Actions:**

- Install Hermes on the VPS per official docs (`curl install.sh | bash`), Linux or macOS.
- `hermes/config.yaml`:
  - `model`: `claude-sonnet-4-5-...` (verify current string from Anthropic docs at install time).
  - `mcp_servers`:
    - `firestore`: command runs `node mcp-servers/firestore-mcp/dist/index.js` (build first).
    - `gmail`, `trello`, `slack`: same pattern.
  - `skills_dir`: `./skills` (relative to `hermes/`).
  - `memory`: default.
  - `cron`: empty for now (Step 8).
  - `privacy.redact_pii: true`.
- Create global skills in `hermes/skills/global/`:
  - `intake-workflow.md` — the top-level playbook. Outlines the full state machine procedure: list emails, for each new one extract → card → draft → post approval → wait for signal → act. References tools by name.
  - `approval-protocol.md` — "You cannot send email without an approval token obtained via the approval signal mechanism. If a tool returns 'approval required', do not retry; wait for the signal." Lists exactly what Hermes must do when it receives an `approvalSignals` doc.
  - `tenant-isolation.md` — "Every tool takes projectId. Never reuse projectId from one thread for another. If list_new_emails returns emails across projects (it won't — it takes projectId — but just in case), treat each projectId strictly separately."
  - `state-machine.md` — the allowed transitions and the step names used in `update_thread`.
- Start Hermes: `hermes --tui`.

**Verification:**
- In Hermes chat: "List all active projects." Hermes calls `firestore_get_project` or `list_active_projects` (add that tool if missing), returns the list.
- "For project <id>, check for new emails." Hermes calls `gmail_list_new_emails(projectId)`. If any, it surfaces them.
- "Create a trello card for thread <id> with title X." Hermes calls `trello_create_card` correctly scoped.
- Confirm Hermes will NOT attempt `gmail_send_reply` (it's not implemented, but also verify skills say so explicitly).
- Confirm audit log entries appear for each tool call.

**Do NOT in Step 7:**
- Do not schedule cron yet.
- Do not turn on learning feedback.
- Do not create per-project skills beyond placeholders (empty files are fine for now).

---

## Step 8 — Hermes cron + full happy-path workflow (without send)

**Goal:** Hermes autonomously polls every project every minute, processes new emails all the way to `awaiting_approval` in Slack. Sending is still blocked (no tokens yet).

**Actions:**

- Per-project extraction skill file at `hermes/skills/projects/{projectId}/extraction.md`:
  - Seeded with the project's `extractionAddendum` plus the base extraction instructions (JSON schema from Part A).
  - `add-project` CLI writes this file on project creation.
- Per-project drafting skill at `hermes/skills/projects/{projectId}/drafting.md`:
  - Seeded with signature and tone notes.
  - `add-project` CLI writes this file.
- Hermes cron entry in `config.yaml`:
  - Every 60 seconds, run skill: `intake-workflow`.
  - The workflow skill tells Hermes: "For every active project (list via firestore_list_active_projects), call gmail_list_new_emails. For each new thread, run the per-project extraction skill, write extraction via update_thread, call trello_create_card, run drafting skill, write draftedReply, call slack_post_approval_message, transition state to awaiting_approval. Then stop for this cron run."
- The `intake-workflow` skill must explicitly instruct: if any step fails, call `append_error` and move on to the next thread; do not halt.

**Verification:**
- Start Hermes, wait for a cron tick.
- Send a realistic dev-work email to a test project's inbox.
- Within ~2 minutes: thread in Firestore at state `awaiting_approval`, Trello card created, Slack approval message posted with the three buttons.
- Send a non-requirement email ("thanks!"). Confirm `changeType: not_a_requirement` and no Trello card, no Slack post (the skill should short-circuit).
- Verify the audit log is comprehensive enough to reconstruct what happened for each thread.
- Simulate a Trello API failure (bad token in Firestore). Confirm Hermes logs the error, sets thread state to reflect the failure, and moves on.

**Do NOT in Step 8:**
- No send. No approval tokens.
- No learning feedback yet.

---

## Step 9 — Approval tokens + send path

**Goal:** Clicking Approve in Slack results in the actual email being sent to the client. Clicking Reject closes the thread. Clicking Edit opens a modal; on submit the draft is updated and re-approved.

**Actions:**

- Guardrail service `POST /slack/events`:
  - On `approve_reply`:
    - Load thread, get `draftedReply` (or `editedReply` if set).
    - Compute `payloadHash = sha256(threadId + replyText)`.
    - Create `approvalTokens/{uuid}` with `threadId`, `projectId`, `kind: send_reply`, `payloadHash`, `expiresAt: now + 10min`, `used: false`, `issuedBy: userId`.
    - Write `approvalSignals/{threadId}` with `{ action: 'approved', tokenId: uuid, userId, at }`.
    - Update the original Slack message: replace buttons with "✅ Approved by <@userId> — sending...".
  - On `reject_reply`:
    - Write `approvalSignals/{threadId}` with `{ action: 'rejected', userId, at }`.
    - Update Slack message to "❌ Rejected by <@userId>".
  - On `edit_reply`:
    - Open a Slack modal pre-populated with `draftedReply`.
    - On modal submit: save `editedReply` on the thread, write `approvalSignals/{threadId}` with `{ action: 'edited', userId, at }`, and re-post a fresh approval message with the new reply (Hermes sees the new signal and re-runs the draft-posting step, or the guardrail service posts directly via `slack-mcp` — simpler is for the guardrail to post directly).
- `gmail-mcp` `send_reply(projectId, threadId, replyText, approvalToken)`:
  - Atomically (via Firestore transaction):
    - Fetches `approvalTokens/{approvalToken}`.
    - Verifies: not used, not expired, threadId matches, kind is `send_reply`, `payloadHash == sha256(threadId + replyText)`.
    - Marks `used: true`, `usedAt: now`.
  - On verification failure: throws a structured error including the specific check that failed. Does NOT send.
  - On success: builds RFC 2822 message with correct `In-Reply-To` and `References` headers derived from `lastMessageIdHeader` and history; `From: project.gmail.inboxEmail`; `Subject: Re: {thread.subject}` (strip existing "Re: " prefixes); body = `replyText` as plain text.
  - Sends via Gmail API with `{ raw, threadId: thread.gmailThreadId }` so it stays threaded.
  - Writes `sentReply`, transitions state to `sent`.
  - Adds a Trello card comment: "Reply sent to client on <date>".
- Update `intake-workflow` skill to watch for `approvalSignals` docs:
  - On every cron tick, after polling emails, list docs in `approvalSignals` that are unconsumed.
  - For each:
    - `approved`: load the token, call `send_reply(projectId, threadId, replyText, tokenId)`. On success, delete the signal. On failure, append error, alert via Slack, leave signal for human intervention.
    - `rejected`: transition thread to `rejected`. Delete signal.
    - `edited`: no action needed (guardrail already re-posted); delete signal.

**Verification:**
- Full happy path: new email → approval post → click Approve → client receives real email on the same thread → Trello card comment appears → thread state `sent`.
- Click Reject → thread `rejected`, client receives nothing.
- Click Edit → modal opens with draft → save with a change → new approval message posted → Approve → client receives the edited version (not the original).
- **Attempt to break the gate:**
  - Manually mint a fake approval token in Firestore and call `send_reply` with it. Should fail on `payloadHash` mismatch (since you don't know the exact reply content hash the real system would use). If it could still succeed because you matched the hash, that's a design flaw — review.
  - Modify `draftedReply` after the approval token is minted (before Hermes sends). `send_reply` should refuse because hash mismatches.
  - Try to reuse a used token. Refused.
  - Let a token expire (10+ min). Refused.
- Audit log contains: token issued, token consumed, email sent.

**Do NOT in Step 9:**
- Do not turn on learning feedback loop.
- Do not add batch approval.

---

## Step 10 — Hooks, audit completeness, and the "dry run" mode

**Goal:** Every Hermes action is auditable. A dry-run mode exists where the `send_reply` tool logs instead of actually sending, for safe testing.

**Actions:**

- `hermes/hooks/pre_llm_call.py`, `post_llm_call.py`, `on_session_end.py`:
  - `pre_llm_call`: log the planned tool call via `log_audit` (tool, input, turnId, sessionId).
  - `post_llm_call`: log the result (output summary, durationMs, errors).
  - `on_session_end`: flush any buffered audit writes.
- Config flag `DRY_RUN=true` in env. When set, `gmail_send_reply` still verifies the token and marks it used, but writes to `dryRunOutbox/{threadId}` instead of calling Gmail API. Still transitions state to `sent` (so downstream behaves normally). Audit log clearly marks the call as dry-run.
- Add `npm run admin -- dry-run <on|off>` to toggle.

**Verification:**
- With `DRY_RUN=on`, run a full flow. No email is delivered. `dryRunOutbox` doc contains the message that would have been sent.
- Audit log of a single approved email contains: cron tick → poll → extract → update_thread → create_card → draft → post_approval → signal_received → send_reply (dry_run=true) → trello_comment → done.
- Flip off, confirm real delivery resumes.

**Do NOT in Step 10:**
- Do not enable learning yet.

---

## Step 11 — Onboard a second project, run the cross-project safety checklist

**Goal:** Prove multi-tenancy is clean under load.

**Actions:**

- Onboard project #2 via `add-project`, different inbox, different board, possibly different Slack channel.
- Send emails to both inboxes simultaneously.
- Run every check in Part A's "Cross-project leak prevention checklist".
- Write `scripts/verify-isolation.ts` that greps Firestore for any doc with mismatched `projectId`/`id` prefix and any audit entry where tool inputs cross projects.

**Verification:**
- Two concurrent emails processed cleanly, correct routing everywhere.
- Deliberately break project #1's Gmail refresh token → project #2 keeps working.
- Disable project #1 mid-run → polling stops for it, #2 continues.
- Audit log diff per project is clean (no cross-tenant data in either).

**Do NOT in Step 11:**
- No new features.

---

## Step 12 — Learning feedback loop (gated)

**Goal:** When humans edit the extraction on the Trello card or the reply in Slack, Hermes considers whether to update the project skill. Gated behind `learning.enabled: false` by default.

**Actions:**

- Add a new field on thread: `humanEdits: { extractionBefore, extractionAfter, replyBefore, replyAfter }`.
- Trello webhook (separate tiny service, or poll Trello API) detects when a card's description is edited and diffs against the extraction. Writes `humanEdits.extractionAfter`.
- Slack edit modal already captures `editedReply`; on submit, writes `humanEdits.replyAfter` alongside `editedReply`.
- A new Hermes cron (e.g. hourly) runs skill `reflect-on-edits`:
  - For threads with populated `humanEdits` not yet reflected on:
    - Pass the before/after pair to Hermes with prompt: "If this edit reveals a generalizable lesson about how to handle emails for project X (or client Y specifically), append a bullet to `skills/projects/{projectId}/extraction.md` (or drafting.md). If it's a one-off, do nothing. Be conservative — one-offs are more common than lessons."
  - Every skill edit writes an entry to `skillReviewQueue` collection with `{ projectId, skillFile, diff, addedAt }`.
- `learning.enabled` env flag. When false, `reflect-on-edits` skill is disabled and edits accumulate but skills are not touched.
- `npm run admin -- skill-review` command that displays recent `skillReviewQueue` entries and lets a human approve/revert each one. Rejected entries revert the skill file to before the change.

**Verification:**
- Deliberately edit an extraction on Trello with a meaningful correction ("for Acme Corp, 'invoice' means billing statement"). Within an hour, `extraction.md` for that project has an appended bullet. `skillReviewQueue` has an entry.
- Run `skill-review`, approve the entry. Queue cleared.
- Run `skill-review`, reject a different entry. Skill file reverts.
- Flip `learning.enabled: false`, edit an extraction, wait: skill unchanged, but `humanEdits` captured for later.

**Do NOT in Step 12:**
- Do not let Hermes modify global skills (`skills/global/`). Only `skills/projects/{projectId}/`.
- Do not let Hermes modify `intake-workflow.md`, `approval-protocol.md`, `tenant-isolation.md`, `state-machine.md` ever.

---

## Step 13 — Deployment hardening

**Goal:** Production-ready on a VPS.

**Actions:**

- Firestore security rules: deny-all for client SDK; only service account works.
- VPS (Ubuntu 22.04/24.04, 4GB RAM):
  - Install Node 20, Python 3.11+, uv, Hermes per docs.
  - Clone repo. `npm ci` at root.
  - Build MCP servers: `npm run build --workspaces`.
  - Systemd units (or `pm2`) for:
    - `guardrail`
    - Hermes (background; Hermes has its own service mode — follow docs).
  - Cloudflare Tunnel configured as a service pointing at guardrail port.
- Daily backup cron: export Firestore `teams`, `projects`, `emailThreads`, `auditLog`, `approvalTokens` to GCS bucket.
- Run a 48-hour dry-run with `DRY_RUN=on` and real email traffic. Check: no gaps in audit, no crashes, no cross-tenant leaks, resource usage within budget.
- Flip off dry-run. Run for one more week before declaring Phase 1 done.

**Do NOT in Step 13:**
- Do not skip the dry-run period. This is the last safety net before real clients receive mail.
- Do not enable `learning.enabled` on the same day you go live. Wait two stable weeks.

---

## Summary of what NOT to do across all steps

- No bypassing the approval-token gate for "faster" testing. Use dry-run mode instead.
- No code changes to client codebases (Phase 2).
- No auto-retry on send failures. Humans handle failures via a new approval.
- No self-editing of global skills by Hermes.
- No cross-project skill reuse by the feedback loop.
- No attachments handling (flag in Slack, human handles).
- No web UI.
- No features not explicitly called for in the current step.
