# Reflect on human edits (gated)

Before doing anything:
1. Call `mcp_firestore_get_project` for the relevant `projectId`.
2. If `learning.enabled` is not true, **stop** (do not modify skill files).

When enabled:
1. Find threads with populated `humanEdits` fields that indicate new human feedback since the last run.
2. Decide if the delta is a durable lesson for this client/project.
3. If yes, append a short bullet to `hermes/skills/projects/{projectId}/extraction.md` or `drafting.md` (never touch `skills/global/`).
4. Call `mcp_firestore_enqueue_skill_review` with the diff and previous file contents for human review.

Be conservative: one-off phrasing changes usually should not become rules.
