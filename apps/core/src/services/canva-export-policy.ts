import { sql, type Database, type Kysely } from '@hawa/db';
import type { PptxCheckOptions } from '@hawa/qa';
import { isServiceUserId } from '@hawa/contracts';
import { computeDnaHash } from '../core-helpers.js';
import { CanvaFlowError } from './canva-flow-error.js';
import { savedDesignCopy, classifyCopyScript } from './saved-design-copy.js';
import { latestRevisionCopy, nativeRevisionHandoff } from './native-revision-handoff.js';

export type ExportCheckPolicy = {
  version: 1;
  kind: 'imported_source' | 'manual_client_dna' | 'revision_client_dna';
  copy: string[];
  requiredFont?: string;
  options: PptxCheckOptions;
  sourceId?: string;
  creationEventId?: string;
  clientId?: string;
  dnaVersion?: number;
  dnaContentHash?: string;
  confirmationEventId?: string;
  taskId?: string;
};

/** Caller owns the task/binding locks. No provider calls or fabricated import metadata. */
export async function resolveManualExportPolicy(
  db: Kysely<Database>, tenantId: string, taskId: string, clientId: string,
): Promise<ExportCheckPolicy> {
  const task = (await sql<{ request_id: string | null; event_id: string; source: unknown }>`
    SELECT t.request_id,e.id AS event_id,e.data AS source FROM hawa.tasks t
    JOIN LATERAL (SELECT id,data FROM hawa.task_events WHERE tenant_id=t.tenant_id AND task_id=t.id
      AND event_type='task.created' ORDER BY aggregate_version LIMIT 1) e ON true
    WHERE t.tenant_id=${tenantId}::uuid AND t.id=${taskId}::uuid AND t.client_id=${clientId}::uuid`.execute(db)).rows[0];
  const source = task?.source as { payload?: { body?: { workflow?: string } }; body?: { workflow?: string } } | undefined;
  const revision = await latestRevisionCopy(db, tenantId, taskId);
  if (!task || task.request_id || (!revision && (source?.payload?.body || source?.body)?.workflow !== 'canva_manual'))
    throw new CanvaFlowError(422, 'SOURCE_REQUIRED', 'Checked export needs a matching imported source or a manual Desk request with exact copy and active client fonts.');
  if (revision) {
    const handoff = await nativeRevisionHandoff(db, tenantId, taskId);
    if (!handoff?.available || handoff.confirmedEventId !== revision.id)
      throw new CanvaFlowError(409, 'REVISION_BASIS_CHANGED', 'Confirm the exact copy against the current linked native design before export.');
  }
  const copy = revision?.copy ?? savedDesignCopy(task.source, '').copy;
  if (copy.join('\n').length > 16000 || copy.some(text => classifyCopyScript(text) === 'unsupported'))
    throw new CanvaFlowError(422, 'COPY_UNSUPPORTED', 'The checked export supports up to 16,000 characters of Latin and Sorani/Arabic copy.');
  const row = (await sql<{ dna: Record<string, unknown>; version: number; content_hash: string; created_by: string | null }>`
    SELECT dna,version,content_hash,created_by FROM hawa.client_dna_versions
    WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid AND status='active'
    ORDER BY version DESC LIMIT 1 FOR SHARE`.execute(db)).rows[0];
  if (!row?.created_by || isServiceUserId(row.created_by)) throw new CanvaFlowError(422, 'CLIENT_REFERENCE_REQUIRED', 'Save an active, human-authored Client DNA version with approved fonts before checking this manual design.');
  const dna = row.dna, hashable = { ...dna };
  delete hashable.__commitMessage; delete hashable.__createdBy;
  if (!dna || dna.tenantId !== tenantId || dna.clientId !== clientId || dna.status !== 'active' ||
      dna.version !== row.version || computeDnaHash(hashable) !== row.content_hash)
    throw new CanvaFlowError(409, 'CLIENT_REFERENCE_CHANGED', 'The active Client DNA identity or content hash is inconsistent.');
  const fonts = Array.isArray(dna.fonts) ? dna.fonts as Array<{ family?: unknown; supportedLocales?: unknown; license?: unknown }> : [];
  const safeName = (value: unknown): value is string => typeof value === 'string' &&
    value.trim() === value && /^[\p{L}\p{N} ._+()-]{1,80}$/u.test(value) && /[\p{L}\p{N}]/u.test(value);
  const families = (locales: string[]) => [...new Set(fonts.filter(font => safeName(font.family) &&
    typeof font.license === 'string' && Boolean(font.license.trim()) && Array.isArray(font.supportedLocales) &&
    locales.some(locale => (font.supportedLocales as unknown[]).includes(locale))).map(font => font.family as string))];
  const allowedFontsByScript = { latin: families(['en']), arabic: families(['ckb', 'ar']) };
  if (copy.some(text => (/[A-Za-z\u00C0-\u024F]/u.test(text) || classifyCopyScript(text) === 'latin') && !allowedFontsByScript.latin.length) ||
      copy.some(text => classifyCopyScript(text) === 'arabic' && !allowedFontsByScript.arabic.length))
    throw new CanvaFlowError(422, 'BRAND_FONTS_REQUIRED', 'The active Client DNA needs explicit licensed font families for every script in the saved copy.');
  return { version: 1, kind: revision ? 'revision_client_dna' : 'manual_client_dna', copy, options: { allowedFontsByScript },
    ...(revision ? { confirmationEventId: revision.id, taskId } : {}),
    creationEventId: task.event_id, clientId, dnaVersion: row.version, dnaContentHash: row.content_hash };
}
