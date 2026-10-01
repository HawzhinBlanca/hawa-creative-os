/**
 * ADR-040 addendum (2026-10-01): a draft's name as the bot shows it, cleaned when it is read.
 *
 * ADR-180 fixed how new tasks are titled: no leading direction mark, and the client is not named twice.
 * ADR-142 stopped the line that introduces the copy ("Here is the text and the photos:") becoming the
 * title. Tasks titled before those fixes keep their stored titles, and the office's "which draft?" list
 * of 2026-10-01 showed them as stored: "KAAE: Here is the text and the photos:…" and "KAAE: KAAE
 * K-12 Pilot Study…" with a right-to-left mark (U+200F) before the second KAAE. Every place that names
 * a draft to an office member or a requester reads the title through here, so stored titles show as
 * new ones would, without rewriting a stored request.
 */
import { sql, type Database, type Kysely } from '@hawa/db';
import { stripLeadingMarks, withoutRepeatedClient } from '../core-helpers.js';
import { isCopyIntroducer } from './request-remarks.js';

/** Direction marks anywhere in a line: invisible, and a title is shown in a line of its own. */
const MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** A line without its direction marks and with its spaces collapsed. */
export const withoutMarks = (text: string) => text.replace(MARKS, '').replace(/\s+/g, ' ').trim();

/** Whether a title (or the name after its client) is the line that introduced the copy. */
export const isIntroducerTitle = (name: string) => isCopyIntroducer(name.replace(/…$/u, ''));

/** The first line of a task's stored copy that is not the introducer (blocks as strings or `{ text }`). */
export function firstCopyLine(copy: unknown): string | null {
  if (!Array.isArray(copy)) return null;
  for (const block of copy) {
    const text = typeof block === 'string' ? block : block && typeof block === 'object' ? (block as { text?: unknown }).text : null;
    if (typeof text !== 'string') continue;
    for (const raw of text.split('\n')) {
      const line = withoutMarks(raw);
      if (line && !isCopyIntroducer(line)) return line;
    }
  }
  return null;
}

/**
 * A stored title as it is shown: without direction marks, the client named once, and, for a title made
 * from the copy's introducer, the request's first line of copy instead ("KAAE: KAAE K-12 Pilot Study"
 * read as "KAAE K-12 Pilot Study"). With no copy to name it, such a title is the client alone, and
 * without a client, null: callers then say "your design" or "Untitled design" as before.
 */
export function cleanDraftTitle(value: string | null | undefined, copy?: unknown): string | null {
  const title = withoutRepeatedClient(stripLeadingMarks(String(value ?? '')).replace(/\s+/g, ' ').trim());
  if (title && isIntroducerTitle(title)) return firstCopyLine(copy);
  const m = title.match(/^([^:\n]{1,40}):\s*([\s\S]*)$/u);
  const client = m ? m[1].replace(MARKS, '').trim() : '';
  const name = (m ? m[2] : title).replace(MARKS, '').trim();
  if (name && isIntroducerTitle(name)) {
    const line = firstCopyLine(copy);
    if (line) return client ? withoutRepeatedClient(`${client}: ${line}`) : line;
    return client || null;
  }
  const shown = (client ? `${client}: ${name}` : name).trim();
  return shown || null;
}

/** The copy a task was opened with (its `task.created` event), for naming a title made from the introducer. */
export async function storedCopy(trx: Kysely<Database>, tenantId: string, taskId: string): Promise<unknown> {
  const row = (await sql<{ copy: unknown }>`SELECT coalesce(e.data->'payload'->'exactCopy', e.data->'exactCopy') AS copy
    FROM hawa.task_events e WHERE e.tenant_id = ${tenantId}::uuid AND e.task_id = ${taskId}::uuid
      AND e.event_type = 'task.created' ORDER BY e.aggregate_version LIMIT 1`.execute(trx)).rows[0];
  return row?.copy ?? null;
}
