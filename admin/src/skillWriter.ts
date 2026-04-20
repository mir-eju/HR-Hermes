import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function extractionTemplate(addendum: string): string {
  return `# Project extraction skill

## Client-specific context
${addendum}

## Output schema (JSON-compatible)
When extracting, populate \`extraction\` on the thread with:
- summary (string)
- changeType: new_feature | modification | bug_fix | removal | clarification | not_a_requirement
- requirements[] (strings)
- affectedAreas[] (strings)
- openQuestions[] (strings)
- outOfScope[] (strings)
- acceptanceCriteria[] (strings)

If the email is social/thanks/noise with no actionable requirement, set changeType to \`not_a_requirement\` and keep requirements empty.

## Procedure
Use \`firestore_update_thread\` to persist extraction and advance state per \`state-machine\` global skill.
`;
}

function draftingTemplate(signature: string, tone: string): string {
  return `# Project drafting skill

## Signature
${signature}

## Tone
${tone}

## Procedure
Draft a concise professional reply acknowledging work in progress. Do not promise delivery dates unless explicitly in the email thread context.
`;
}

export function writeProjectSkillFiles(repoRoot: string, projectId: string, input: { extractionAddendum: string; replySignature: string; replyToneNotes: string }): void {
  const base = join(repoRoot, "hermes", "skills", "projects", projectId);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "extraction.md"), extractionTemplate(input.extractionAddendum), "utf8");
  writeFileSync(join(base, "drafting.md"), draftingTemplate(input.replySignature, input.replyToneNotes), "utf8");
}
