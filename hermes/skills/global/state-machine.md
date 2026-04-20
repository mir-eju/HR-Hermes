# Email thread state machine

States:
`received → extracted → carded → drafted → awaiting_approval → sent`
Side paths: `rejected`, `closed`, `edited` (edited returns to approval flow).

## Firestore updates
Use `mcp_firestore_update_thread` with:
- `threadId`
- `patch` containing fields to merge
- optional `expectedState` for optimistic locking
- `by` (e.g. `hermes` or `user:U123`)
- `step` (short machine-friendly label)

## Extraction JSON (shape)
```
{
  "summary": "",
  "changeType": "new_feature|modification|bug_fix|removal|clarification|not_a_requirement",
  "requirements": [],
  "affectedAreas": [],
  "openQuestions": [],
  "outOfScope": [],
  "acceptanceCriteria": []
}
```

## Banned transitions
Never set `state: sent` via `update_thread` — only the Gmail send path does that.
