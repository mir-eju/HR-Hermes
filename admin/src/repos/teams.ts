import type { Firestore } from "firebase-admin/firestore";
import { collections, now } from "@hr-hermes/shared";
import type { Team } from "@hr-hermes/shared";

export async function createTeam(
  db: Firestore,
  input: { id: string; name: string }
): Promise<void> {
  const ref = db.collection(collections.teams).doc(input.id);
  const snap = await ref.get();
  if (snap.exists) {
    throw new Error(`Team already exists: ${input.id}`);
  }
  const t = now();
  const team: Team = {
    id: input.id,
    name: input.name,
    active: true,
    createdAt: t as unknown as Team["createdAt"],
    updatedAt: t as unknown as Team["updatedAt"],
  };
  await ref.set(team);
}

export async function getTeam(db: Firestore, id: string): Promise<Team | null> {
  const snap = await db.collection(collections.teams).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as Team;
}

export async function listTeams(db: Firestore): Promise<Team[]> {
  const qs = await db.collection(collections.teams).get();
  return qs.docs.map((d) => d.data() as Team);
}

export async function setTeamActive(db: Firestore, id: string, active: boolean): Promise<void> {
  const ref = db.collection(collections.teams).doc(id);
  await ref.update({ active, updatedAt: now() });
}
