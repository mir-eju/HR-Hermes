/** Thread document id: `{projectId}__{gmailThreadId}` */
export function makeThreadId(projectId: string, gmailThreadId: string): string {
  return `${projectId}__${gmailThreadId}`;
}

export function parseThreadId(threadId: string): { projectId: string; gmailThreadId: string } {
  const idx = threadId.indexOf("__");
  if (idx <= 0 || idx === threadId.length - 2) {
    throw new Error(`Invalid threadId format: ${threadId}`);
  }
  return {
    projectId: threadId.slice(0, idx),
    gmailThreadId: threadId.slice(idx + 2),
  };
}

export function assertThreadProject(threadId: string, projectId: string): void {
  const p = parseThreadId(threadId);
  if (p.projectId !== projectId) {
    throw new Error(`threadId prefix mismatch: expected ${projectId}, got ${p.projectId}`);
  }
}
