import { sql, type Database, type Kysely } from '@hawa/db';

export interface NamedReviewAuthority {
  assignmentId: string;
  assignmentVersion: number;
}

/** SQL owns the locks and admission joins; a signed event's role alone grants nothing. */
export async function lockNamedReviewAuthority(db: Kysely<Database>, input: {
  tenantId: string;
  sessionHash: string;
  userId: string;
  clientId: string;
  projectId: string | null;
}): Promise<NamedReviewAuthority | null> {
  if (!/^[a-f0-9]{64}$/.test(input.sessionHash)) return null;
  const row = (await sql<{ assignment_id: string; assignment_version: string }>`
    SELECT * FROM hawa.lock_named_office_reviewer(
      ${input.tenantId}::uuid, ${input.sessionHash}, ${input.userId}::uuid,
      ${input.clientId}::uuid, ${input.projectId}::uuid)
  `.execute(db)).rows[0];
  return row ? { assignmentId: row.assignment_id, assignmentVersion: Number(row.assignment_version) } : null;
}
