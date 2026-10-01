import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CanvaBindingRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';

/**
 * ADR-155 addendum (owner report 2026-09-30: "the designs are not sent to the telegram, neither the
 * link of the img in the app"). The office's "design ready" alert was one line with the task's UUID
 * and, with the Desk at http://127.0.0.1:8080, no link at all. Core now gives every office member a
 * photo alert: the draft's picture by reference (the Canva PNG export, else the Studio winner preview)
 * and a caption with the design's name, who it is for, its Canva link and where it is approved. The
 * text alert keeps the same words for a worker from before. The requester's message is unchanged.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = ['91500001', '91500002'];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function designed(picture: 'export' | 'preview' | 'none', report: Record<string, unknown> = {}) {
  vi.stubEnv('TELEGRAM_ALLOWED_USERS', OFFICE.join(','));
  const chat = String(66_000_000 + Math.floor(Math.random() * 8_000_000));
  const requestId = randomUUID();
  const opened = await projectLifecycleOpen(db, {
    requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
    draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chat,
      rawText: 'Autumn workshop poster', title: 'Autumn workshop poster', designInstructions: 'Use the exact copy',
      exactCopy: ['Autumn workshop poster'], clientId, autoGenerate: true, designStudio: false },
  });
  const taskId = opened.taskId;
  const designId = `DA${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const png = Buffer.from(`png of ${taskId}`);
  const pictureId = randomUUID();
  await withRlsContext(db, scope, async (trx) => {
    await new CanvaBindingRepository(trx).createBinding({ tenantId, taskId, clientId, canvaDesignId: designId,
      editUrl: `https://www.canva.com/design/${designId}/edit` }, trx);
    const binding = await trx.selectFrom('canva_bindings').select(['canva_design_id', 'version'])
      .where('tenant_id', '=', tenantId).where('task_id', '=', taskId).executeTakeFirstOrThrow();
    if (picture === 'export') {
      const operationId = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations
        (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata)
        VALUES (${operationId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${`preview-${operationId}`},
          ${sha(png)}, 'export', 'retrieved', ${binding.canva_design_id}, ${binding.version}, ${JSON.stringify({ format: 'png' })}::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content)
        VALUES (${pictureId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${operationId}::uuid, 'png', ${sha(png)}, ${png})`.execute(trx);
    } else if (picture === 'preview') {
      const runId = randomUUID();
      await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status, stages)
        VALUES (${runId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, 'test', ${randomUUID()}, 'h', '{}'::jsonb, 'standard', 'transferred', '{}'::jsonb)`.execute(trx);
      await sql`INSERT INTO hawa.design_studio_candidates (id, run_id, tenant_id, ordinal, concept, status, preview_png, preview_sha256)
        VALUES (${pictureId}::uuid, ${runId}::uuid, ${tenantId}::uuid, 0, '{}'::jsonb, 'winner', ${png}, ${sha(png)})`.execute(trx);
    }
  });
  const runId = `dr-${taskId}`;
  const result = await projectLifecycleDesignOutcome(db, {
    requestId, tenantId, taskId, runId, expectedRev: 1, rev: 2, key: `${requestId}:2:designFinished:${runId}`,
    report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId, ...report },
  });
  const client = await withRlsContext(db, scope, (trx) => trx.selectFrom('clients').select('name')
    .where('id', '=', clientId).executeTakeFirstOrThrow());
  return { requestId, taskId, designId, chat, pictureId, png, result, clientName: client.name };
}

describe('D5 addendum: the office sees the draft it is asked to review', () => {
  it('each office member gets a photo alert naming the Canva export by hash, with a plain caption and no UUIDs', async () => {
    vi.stubEnv('HAWA_DESK_BASE_URL', 'http://127.0.0.1:8080');
    const { taskId, designId, pictureId, png, result, clientName } = await designed('export');
    expect(result.stage).toBe('in_review');
    expect(result.officePhotoAlerts?.map((a) => a.chatId)).toEqual(OFFICE);
    expect(result.officePhotoAlerts?.[1].image).toEqual({ source: 'canva_export', tenantId, taskId, id: pictureId, sha256: sha(png) });
    const caption = result.officePhotoAlerts![0].text;
    expect(caption).toContain('"Autumn workshop poster"');
    expect(caption).toContain(`For ${clientName}`);
    expect(caption).toContain(`Edit in Canva: https://www.canva.com/design/${designId}/edit`);
    // ADR-180: office members approve in Telegram (ADR-040 addendum), so the caption says how, in plain
    // words, in English and Sorani. ADR-239 (changed deliberately): plain chat, no reply target.
    expect(caption).toContain('Just say “approved” to send it to the requester, or tell me what to change. You can also decide in Hawa Desk.');
    expect(caption).not.toMatch(/reply to/i);
    expect(caption).toContain('«پەسەندە»');
    expect(caption).not.toContain('office computer');
    expect(caption).not.toContain('127.0.0.1');
    expect(caption).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    // The text alert goes without the picture (or from a worker from before), and approving in
    // Telegram needs the picture: it still says where approval happens.
    const text = result.officeAlerts![0].text;
    expect(text).toContain('Hawa Desk on the office computer');
    expect(text).not.toContain('Just say “approved”');
    expect(result.officeAlerts).toEqual(OFFICE.map((chatId) => ({ chatId, text })));
    expect(result.officeAlert).toEqual(result.officeAlerts![0]);
  });

  it('without an export yet, the Studio winner preview is the picture', async () => {
    const { taskId, pictureId, png, result } = await designed('preview');
    expect(result.officePhotoAlerts?.[0].image).toEqual({ source: 'studio_preview', tenantId, taskId, id: pictureId, sha256: sha(png) });
  });

  it('with no picture at all, the alert is text, never nothing', async () => {
    const { designId, result } = await designed('none');
    expect(result.officePhotoAlerts).toBeUndefined();
    expect(result.officeAlerts?.map((a) => a.chatId)).toEqual(OFFICE);
    expect(result.officeAlerts?.[0].text).toContain(`https://www.canva.com/design/${designId}/edit`);
  });

  it('a public https Desk keeps its review link in the caption', async () => {
    vi.stubEnv('PUBLIC_TUNNEL_URL', 'https://desk.example.test');
    const { taskId, result } = await designed('export');
    expect(result.officePhotoAlerts?.[0].text).toContain(
      `Hawa Desk (office sign-in required): https://desk.example.test/#/work?task=${taskId}&revision=${result.revisionId}`);
  });

  it('the requester is sent no picture and no link before approval: their message is unchanged', async () => {
    const { chat, result } = await designed('export');
    expect(OFFICE).not.toContain(chat);
    expect(result.officePhotoAlerts?.some((a) => a.chatId === chat)).toBe(false);
    expect(result.message?.text).not.toMatch(/canva\.com|office computer|Hawa Desk/);
    expect(Object.keys(result.message ?? {}).sort()).toEqual(['parseMode', 'text']);
  });

  it('a draft with a failed check says so; a failure with no design stays text, with no picture', async () => {
    const { designId, result } = await designed('export', { status: 'CANVA_COPY_MISMATCH' });
    expect(result.officePhotoAlerts?.[0].text).toContain('The automatic check reported CANVA_COPY_MISMATCH');
    expect(result.officePhotoAlerts?.[0].text).toContain(`Edit in Canva: https://www.canva.com/design/${designId}/edit`);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', OFFICE[0]);
    const requestId = randomUUID();
    const opened = await projectLifecycleOpen(db, {
      requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: '66999999',
        rawText: 'Autumn workshop poster', title: 'Autumn workshop poster', designInstructions: 'Use the exact copy',
        exactCopy: ['Autumn workshop poster'], clientId, autoGenerate: true, designStudio: false },
    });
    const runId = `dr-${opened.taskId}`;
    const failed = await projectLifecycleDesignOutcome(db, {
      requestId, tenantId, taskId: opened.taskId, runId, expectedRev: 1, rev: 2, key: `${requestId}:2:designFinished:${runId}`,
      report: { status: 'DESIGN_FAILED', code: 'STUDIO_FAILED' },
    });
    expect(failed.officePhotoAlerts).toBeUndefined();
    // ADR-233: plain words, not "Automatic design needs an operator … DESIGN_FAILED (STUDIO_FAILED)".
    expect(failed.officeAlert?.text).toContain('stopped without a draft');
    expect(failed.officeAlert?.text).not.toContain('STUDIO_FAILED');
  });
});
