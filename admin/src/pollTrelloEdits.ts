import { initFirebaseFromConfig, loadConfig, collections, decrypt } from "@hr-hermes/shared";
import type { EmailThread, Project } from "@hr-hermes/shared";

function trelloCardUrl(key: string, token: string, cardId: string) {
  return `https://api.trello.com/1/cards/${cardId}?fields=desc&key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

async function main() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const qs = await db.collection(collections.emailThreads).limit(200).get();
  for (const doc of qs.docs) {
    const th = doc.data() as EmailThread;
    if (!th.trelloCardId || !th.projectId) continue;
    const pSnap = await db.collection(collections.projects).doc(th.projectId).get();
    if (!pSnap.exists) continue;
    const p = pSnap.data() as Project;
    const key = decrypt(p.trello.apiKeyEncrypted, cfg.ENCRYPTION_KEY);
    const token = decrypt(p.trello.tokenEncrypted, cfg.ENCRYPTION_KEY);
    const res = await fetch(trelloCardUrl(key, token, th.trelloCardId));
    if (!res.ok) continue;
    const card = (await res.json()) as { desc?: string };
    const desc = card.desc || "";
    const baseline = JSON.stringify(th.extraction || {});
    if (desc && desc !== baseline && desc.length > 10) {
      await doc.ref.set(
        {
          humanEdits: {
            ...(th.humanEdits || {}),
            extractionBefore: baseline,
            extractionAfter: desc,
          },
        },
        { merge: true }
      );
    }
  }
  console.log("poll-trello-edits: done");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
