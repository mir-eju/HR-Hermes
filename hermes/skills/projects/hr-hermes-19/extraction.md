# Project extraction skill

## Client-specific context


## Output schema (JSON-compatible)
When extracting, populate `extraction` on the thread with:
- summary (string)
- changeType: new_feature | modification | bug_fix | removal | clarification | not_a_requirement
- requirements[] (strings)
- affectedAreas[] (strings)
- openQuestions[] (strings)
- outOfScope[] (strings)
- acceptanceCriteria[] (strings)

If the email is social/thanks/noise with no actionable requirement, set changeType to `not_a_requirement` and keep requirements empty.

## Procedure
Use `firestore_update_thread` to persist extraction and advance state per `state-machine` global skill.
