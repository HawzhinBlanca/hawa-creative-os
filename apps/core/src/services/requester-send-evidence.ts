import { deliveryBaseId } from '@hawa/contracts';
import { PublicationRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

export type RecordedSendOutcome = 'not_attempted' | 'attempted' | 'sent' | 'uncertain' | 'failed' | 'released';

export interface RecordedSendStep {
  sendKey: string;
  outcome: RecordedSendOutcome;
  attemptCount: number;
  lastMarkAt: string | null;
}

export interface RequesterSendEvidence {
  taskId: string;
  requestId: string;
  requestRev: number;
  publicationId: string;
  approvalId: string;
  requesterChatId: string | null;
  /** Send marks are local worker records; the Bot API gives no requester-read receipt here. */
  providerReceipt: 'not_available';
  files: Array<RecordedSendStep & { artifactId: string; filename: string; sha256: string }>;
  notice: RecordedSendStep;
}

export type RequesterSendEvidenceRead =
  | { kind: 'found'; evidence: RequesterSendEvidence }
  | { kind: 'not_found' }
  | { kind: 'wrong_state' };

const MARK_KIND = /^telegram_(document|notice|message)_(attempted|sent|uncertain|failed|released)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PackageFile { artifactId: string; name: string; sha256: string }

function packageFiles(manifest: Record<string, unknown>): PackageFile[] {
  const raw = manifest.files;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('The approved delivery package has no recorded files');
  const files = raw.map((file) => {
    if (!file || typeof file !== 'object') throw new Error('The approved delivery package is malformed');
    const item = file as Record<string, unknown>;
    if (typeof item.artifactId !== 'string' || !UUID.test(item.artifactId)) {
      throw new Error('The approved delivery package has an invalid artifact ID');
    }
    if (typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error('The approved delivery package has no file name');
    }
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw new Error('The approved delivery package has an invalid file hash');
    }
    return { artifactId: item.artifactId, name: item.name, sha256: item.sha256 };
  });
  if (new Set(files.map((file) => file.artifactId)).size !== files.length) {
    throw new Error('The approved delivery package repeats a file identity');
  }
  return files;
}

/** A tenant-scoped read of the exact keys that Delivery and TelegramSender use for this approval. */
export async function readRequesterSendEvidence(
  db: Kysely<Database>, input: { tenantId: string; userId: string; role: string; taskId: string },
): Promise<RequesterSendEvidenceRead> {
  return withRlsContext(db, { tenantId: input.tenantId, userId: input.userId, role: input.role }, async (trx) => {
    const task = await trx.selectFrom('tasks').select(['request_id', 'state'])
      .where('tenant_id', '=', input.tenantId).where('id', '=', input.taskId).executeTakeFirst();
    if (!task) return { kind: 'not_found' };
    if (!task.request_id || task.state !== 'publishing') return { kind: 'wrong_state' };
    const request = await trx.selectFrom('requests').select(['rev', 'owner', 'stage', 'current_task_id', 'chat_id'])
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', task.request_id).executeTakeFirst();
    const publication = await new PublicationRepository(trx).findByTaskId(input.taskId, input.tenantId, trx);
    if (!request || request.owner !== 'restate' || request.stage !== 'delivering' ||
        request.current_task_id !== input.taskId || publication?.error_class !== 'REQUESTER_SEND_UNCONFIRMED' ||
        publication.executor !== 'restate') return { kind: 'wrong_state' };
    const files = packageFiles(publication.package_manifest);
    const base = deliveryBaseId(input.taskId, publication.approval_id);
    const sendKeys = files.map((file) => `${base}:file:${file.artifactId}`);
    const noticeKey = `${base}:notice`;
    const markKeys = [...sendKeys, noticeKey].map((key) => `lc:${key}:send`);
    const rows = (await sql<{ source_event_id: string; event_kind: string; received_at: Date; attempt_count: string }>`
      SELECT DISTINCT ON (source_event_id) source_event_id, event_kind, received_at,
        count(*) FILTER (WHERE event_kind ~ '_attempted$') OVER (PARTITION BY source_event_id) AS attempt_count
      FROM hawa.inbox_events
      WHERE tenant_id = ${input.tenantId}::uuid AND source_account_id = 'telegram_delivery'
        AND source_event_id = ANY(${markKeys}::text[])
      ORDER BY source_event_id, received_at DESC, id DESC`.execute(trx)).rows;
    const marks = new Map(rows.map((row) => [row.source_event_id, row]));
    const step = (key: string, expectedKind: 'document' | 'notice'): RecordedSendStep => {
      const row = marks.get(`lc:${key}:send`);
      if (!row) return { sendKey: key, outcome: 'not_attempted', attemptCount: 0, lastMarkAt: null };
      const parsed = MARK_KIND.exec(row.event_kind);
      if (!parsed || (expectedKind === 'document' && parsed[1] !== 'document') ||
          (expectedKind === 'notice' && parsed[1] !== 'message' && parsed[1] !== 'notice')) {
        throw new Error('The recorded Telegram send mark is malformed');
      }
      return { sendKey: key, outcome: parsed[2] as RecordedSendOutcome,
        attemptCount: Number(row.attempt_count), lastMarkAt: row.received_at.toISOString() };
    };
    return { kind: 'found', evidence: {
      taskId: input.taskId, requestId: task.request_id, requestRev: Number(request.rev),
      publicationId: publication.id, approvalId: publication.approval_id,
      requesterChatId: request.chat_id, providerReceipt: 'not_available',
      files: files.map((file, index) => ({ artifactId: file.artifactId,
        filename: file.name, sha256: file.sha256, ...step(sendKeys[index], 'document') })),
      notice: step(noticeKey, 'notice'),
    } };
  });
}
