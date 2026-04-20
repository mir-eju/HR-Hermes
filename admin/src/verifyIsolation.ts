import { initFirebaseFromConfig, loadConfig, collections, parseThreadId } from "@hr-hermes/shared";

async function main() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const threads = await db.collection(collections.emailThreads).limit(500).get();
  let bad = 0;
  for (const d of threads.docs) {
    const t = d.data() as { projectId?: string };
    if (!t.projectId) {
      bad++;
      continue;
    }
    try {
      const p = parseThreadId(d.id);
      if (p.projectId !== t.projectId) {
        console.error(`Mismatch thread ${d.id}: prefix ${p.projectId} vs field ${t.projectId}`);
        bad++;
      }
    } catch {
      console.error(`Bad thread id format: ${d.id}`);
      bad++;
    }
  }
  const audits = await db.collection(collections.auditLog).limit(200).get();
  for (const d of audits.docs) {
    const a = d.data() as { projectId?: string; threadId?: string; input?: { projectId?: string } };
    const inPid = a.input && typeof a.input === "object" ? (a.input as { projectId?: string }).projectId : undefined;
    if (inPid && a.projectId && inPid !== a.projectId) {
      console.error(`Audit cross-project hint: ${d.id}`);
      bad++;
    }
    if (a.threadId) {
      try {
        const p = parseThreadId(String(a.threadId));
        if (a.projectId && p.projectId !== a.projectId) {
          console.error(`Audit thread prefix mismatch: ${d.id}`);
          bad++;
        }
      } catch {
        /* threadId may not be canonical in some audit rows */
      }
    }
  }
  if (bad) process.exit(1);
  console.log("verify-isolation: OK");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
