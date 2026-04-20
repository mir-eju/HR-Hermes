# HR-Hermes (Phase 1)

Multi-tenant **email → extraction → Trello → Slack approval → Gmail reply** pipeline with mechanical approval tokens (see [PHASE_1_PLAN (1).md](./PHASE_1_PLAN%20(1).md)). This repo implements the Node/Firestore/MCP/guardrail pieces and Hermes-facing config/skills. **Step 13 (VPS deploy) is intentionally out of scope** here; everything below is local-first.

## Prerequisites

- **Node.js 20+**
- **Hermes Agent** installed ([Hermes docs](https://hermes-agent.nousresearch.com/)) and a working **Anthropic** key in Hermes’ environment
- **Firebase** project with **Firestore** enabled
- **GCP service account** JSON with Firestore access (server client, not end-user SDK)
- **Google Cloud OAuth** client (Desktop or Web) with **Gmail API** enabled and authorized redirect `http://127.0.0.1:3333/oauth2callback` (or override via env)
- **Slack app** with bot token, signing secret, a channel for approvals, **Interactivity** pointing at your tunnel URL + `/slack/events`
- **Trello** API key + token with access to the target board/list

## One-time setup

1. Clone and install:

   ```bash
   cd HR-Hermes
   cp .env.example .env
   npm install
   npm run build
   ```

2. Put your service account JSON somewhere outside git and set `FIREBASE_SERVICE_ACCOUNT_PATH` to its **absolute** path.

3. Generate `ENCRYPTION_KEY` (64 hex chars = 32 bytes):

   ```bash
   python3 -c "import secrets; print(secrets.token_hex(32))"
   ```

4. Deploy Firestore composite indexes (required for some queries):

   ```bash
   firebase deploy --only firestore:indexes
   ```

   (Uses [firestore.indexes.json](./firestore.indexes.json).) Optional: deploy [firestore.rules](./firestore.rules) so only the service account can access data.

5. **Hermes home**: Hermes reads `~/.hermes` by default. Recommended layout:

   ```bash
   export HR_HERMES_ROOT="$(pwd)"   # this repository root — required for MCP paths in hermes/config.yaml
   export HERMES_HOME="$HOME/.hermes-hr-hermes"
   mkdir -p "$HERMES_HOME"
   cp hermes/config.yaml "$HERMES_HOME/config.yaml"
   ```

   Symlink skills so edits from `npm run admin -- add-project` land where Hermes loads them:

   ```bash
   ln -sfn "$HR_HERMES_ROOT/hermes/skills" "$HERMES_HOME/skills"
   ```

6. **Audit plugin (Step 10)**: copy the plugin into Hermes’ plugin scan path (exact location depends on your Hermes version; often `~/.hermes/plugins/`):

   ```bash
   ln -sfn "$HR_HERMES_ROOT/hermes/plugins/hr_hermes_audit" "$HERMES_HOME/plugins/hr_hermes_audit"
   ```

   The plugin shells out to `node admin/dist/cli.js hook-audit` with JSON on stdin, so **`npm run build` must succeed** and `HR_HERMES_ROOT` must be set when Hermes runs.

7. **Slack → guardrail**: Slack interactivity must hit a **public HTTPS** URL. For local dev use **Cloudflare Tunnel** or **ngrok** to expose `http://127.0.0.1:$GUARDRAIL_PORT`, e.g.:

   ```bash
   npm run build
   node guardrail/dist/index.js
   # elsewhere: cloudflared tunnel --url http://127.0.0.1:8787
   ```

   Set the Slack app **Interactivity** URL to `https://<your-tunnel-host>/slack/events`.

8. **Cron / gateway**: Hermes schedules recurring work via `hermes cron` / gateway (see Hermes docs). After MCPs work in chat, create a job equivalent to:

   ```bash
   hermes cron create "every 1m" "Execute the global skill intake-workflow end-to-end for all active projects." --skill intake-workflow --name hr-hermes-intake
   ```

   Ensure the **gateway** process is running if you rely on cron delivery.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `FIREBASE_PROJECT_ID` | GCP / Firebase project id |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Absolute path to service account JSON |
| `ENCRYPTION_KEY` | AES-256-GCM key for secrets at rest (64 hex or 32-byte base64) |
| `SLACK_SIGNING_SECRET` | Verifies Slack requests to guardrail |
| `ANTHROPIC_API_KEY` | Used by Hermes (also listed here so MCP child env can inherit) |
| `GUARDRAIL_PORT` | Port for guardrail HTTP server |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `HR_HERMES_ROOT` | Absolute path to this repo (MCP `args` in `hermes/config.yaml`) |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Gmail OAuth for `add-project` |
| `GOOGLE_OAUTH_REDIRECT_URI` | Defaults to `http://127.0.0.1:3333/oauth2callback` |
| `DRY_RUN` | When `true`, `send_reply` writes `dryRunOutbox` and skips Gmail API |
| `LEARNING_ENABLED` | Hint for skills; project `learning.enabled` still gates writes |

Per-project **Slack**, **Trello**, and **Gmail** credentials are stored **encrypted** in Firestore via the admin CLI.

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build all workspaces (`shared`, MCPs, guardrail, admin) |
| `npm run admin -- add-team --id <id> --name "Name"` | Create team |
| `npm run admin -- add-project` | Interactive Gmail OAuth + secrets + writes `hermes/skills/projects/<id>/` |
| `npm run admin -- list-projects` | List projects |
| `npm run admin -- disable-project <id>` | Soft-disable a project |
| `npm run admin -- dry-run on\|off` | Global dry-run flag in `_config/runtime` |
| `npm run admin -- dry-run-project <id> on\|off` | Per-project dry-run |
| `npm run admin -- learning <id> on\|off` | Toggle `learning.enabled` on a project |
| `npm run admin -- skill-review` | Triage `skillReviewQueue` entries |
| `npm run verify-isolation` | Sanity-check thread id prefixes vs `projectId` |
| `npm run poll-trello-edits` | Heuristic poll: Trello card description vs stored extraction |
| `node guardrail/dist/index.js` | Run guardrail after `npm run build` |
| `npm run hook-audit` | Pipe JSON stdin → Firestore audit (used by Hermes plugin) |

## MCP servers (stdio)

After `npm run build`, each server is at `mcp-servers/<name>/dist/index.js`. Hermes wiring is in [hermes/config.yaml](./hermes/config.yaml) (uses `${HR_HERMES_ROOT}`).

## Safety model (short)

- Only the **guardrail** mints `approvalTokens` after a verified Slack approval.
- `gmail-mcp` **`send_reply`** consumes a token in a transaction, then sends (or dry-run outbox). `payloadHash` binds token to `threadId + replyText`.

## Learning (Step 12)

- Trello description drift is picked up by `npm run poll-trello-edits` (run on a schedule with cron/systemd if you like).
- Hermes skill [hermes/skills/global/reflect-on-edits.md](./hermes/skills/global/reflect-on-edits.md) + `mcp_firestore_enqueue_skill_review` + `npm run admin -- skill-review`.

## Deploy (later)

See Phase 1 plan **Step 13**: systemd/pm2 for guardrail + Hermes gateway, hardened tunnel, backups — not automated in this repo.
