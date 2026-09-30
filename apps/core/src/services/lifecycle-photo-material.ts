/**
 * A requester's photo for a design that is still being made (ADR-156, audit #11 and #12): "use this
 * logo" with a photo, or a photo sent as a reply to the brief, to the bot's "making a first draft"
 * message or to a colleague's message. The photo is material for that design, never a new request and
 * never an untrue "it is with the office now".
 *
 * It is added to the design's task files (`reference_image`) while the design has not started using
 * pictures (no design run yet, or one still reading its brief with no pinned visual basis), or while a
 * designer makes it by hand: the rule ADR-145 uses for a photo sent right after a brief
 * (lifecycle-media-route.ts). Otherwise it stays in the chat and the office is told. The caller keeps
 * the words and the note for the office under the update, once.
 */
import { sql, type Database, type Kysely } from '@hawa/db';
import type { BlobRef } from '@hawa/contracts';

type Tx = Kysely<Database>;

/** Stages in which a photo can still become material of the design itself. */
export const MATERIAL_STAGES = ['designing', 'manual'] as const;

/**
 * Adds the photo to the request's current task when the design can still use it: `added`, else
 * `passed` (the office uses it). Idempotent: the same photo is one task file however often it is added.
 */
export async function addPhotoMaterial(trx: Tx, tenantId: string, target: { requestId: string; taskId: string; stage: string },
  image: BlobRef): Promise<'added' | 'passed'> {
  if (!(MATERIAL_STAGES as readonly string[]).includes(target.stage)) return 'passed';
  await sql`SELECT 1 FROM hawa.requests WHERE tenant_id = ${tenantId}::uuid AND request_id = ${target.requestId}::uuid
    FOR UPDATE`.execute(trx);
  const run = (await sql<{ status: string; pinned: boolean }>`SELECT r.status,
      EXISTS (SELECT 1 FROM hawa.studio_visual_inputs v WHERE v.tenant_id = r.tenant_id AND v.run_id = r.id) AS pinned
    FROM hawa.design_studio_runs r WHERE r.tenant_id = ${tenantId}::uuid AND r.task_id = ${target.taskId}::uuid
    ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE OF r`.execute(trx)).rows[0];
  const usable = target.stage === 'manual' || !run || (['briefing', 'conceiving'].includes(run.status) && !run.pinned);
  if (!usable) return 'passed';
  await sql`INSERT INTO hawa.task_files (tenant_id, task_id, sha256, role)
    VALUES (${tenantId}::uuid, ${target.taskId}::uuid, ${image.sha256}, 'reference_image')
    ON CONFLICT DO NOTHING`.execute(trx);
  return 'added';
}

/** The line the office reads under the requester's words, saying where the photo is. */
export function photoMaterialLine(outcome: 'added' | 'passed'): string {
  return outcome === 'added'
    ? '[The requester sent a photo with this. It was added to the design\'s files.]'
    : '[The requester sent a photo with this. It is in the Telegram chat and was not added to the design, which had already started using its pictures.]';
}
