# Intake workflow (cron)

You are operating the Hermes HR-Hermes intake agent. Follow these steps on each run.

## 0) Safety
- Never call `mcp_gmail_send_reply` unless you have a valid `tokenId` from an `approved` Slack signal and you pass the **exact** approved reply text.
- If `mcp_gmail_send_reply` returns an error, do not loop blindly: `append_error`, leave the approval signal for humans, and continue.

## 1) Poll inboxes
1. Call `mcp_firestore_list_active_projects`.
2. For each `projectId`, call `mcp_gmail_list_new_emails` with that `projectId`.

## 2) New threads
For each returned `{ threadId, summaryLine }`:
1. Load the per-project extraction skill file referenced by the project (`skills.projects...extraction`) using your skill context.
2. Produce structured extraction JSON matching the schema in `state-machine.md`.
3. Call `mcp_firestore_update_thread` to persist `extraction`, advance state through `extracted` → `carded` as appropriate, include `by=hermes` and a meaningful `step`.
4. Call `mcp_trello_create_card` with checklist items from `extraction.requirements` when changeType is **not** `not_a_requirement`.
5. If `not_a_requirement`, skip Trello + Slack and close out the thread state appropriately via `update_thread`.
6. Draft a reply using the per-project drafting skill.
7. Persist `draftedReply` and move state to `drafted`, then `awaiting_approval`.
8. Call `mcp_slack_post_approval_message` with extraction JSON, drafted reply text, and Trello URL.

If any step fails: call `mcp_firestore_append_error` and continue to the next thread.

## 3) Approval signals
1. For each active project, call `mcp_firestore_list_approval_signals` with `projectId`.
2. For each signal:
   - `approved` with `tokenId`: load the thread, choose `editedReply || draftedReply` as the reply text, call `mcp_gmail_send_reply` with `(projectId, threadId, replyText, tokenId)`.
     - On success: `mcp_firestore_delete_approval_signal` with `threadId`.
   - `rejected`: ensure thread is `rejected`, then delete the signal.
   - `edited` / `edit_reply`: delete the signal (guardrail already reposted Slack).

## 4) Learning (optional)
If a project has `learning.enabled=true`, run the `reflect-on-edits` skill on a slower cadence (manual for now unless a separate cron job is installed).
