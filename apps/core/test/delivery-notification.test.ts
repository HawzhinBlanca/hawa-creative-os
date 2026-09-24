import crypto from 'node:crypto';
import { describe, expect, it, afterAll } from 'vitest';
import { createDb } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import {
  buildDeliveredNotificationPayload,
  deliveredNotificationKey,
  requesterChatFromIntake,
  resolveRequesterChat,
} from '../src/services/delivery-notification.js';
import { memoryExportStore } from './pinned-exports-fixture.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/**
 * The requester is told about a delivery once the approved files are verified in Drive, and the
 * notification carries the files themselves. Until now `notify.published` was written only when the
 * Sheets row was confirmed too, so a client with no ledger left the requester unnotified for good,
 * and the message named only the client's root Drive folder.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
// FastPay's seeded client row, given KAAE's DNA without a spreadsheet: Postgres keeps DNA only
// for a client it holds.
const NO_SHEET_CLIENT = 'c1000000-0000-4000-8000-000000000004';
const REQUESTER_CHAT = 4343;
const json = { 'Content-Type': 'application/json' };
const auth = { ...json, Authorization: 'Bearer test_bearer' };

/** A QA engine whose every run passes. */
const passingQa = {
  run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
    ok: true as const,
    value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
  }),
};

async function setup() {
  const exports = memoryExportStore();
  // QA passes: a chat request's brief would fail the QA route's fixed manifest, and QA is not the subject.
  const app = createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true }, deliverableStore: exports.store, qaEngine: passingQa as never });
  const kaaeDna = await (await app.request(`/clients/${KAAE}/dna`)).json();
  const saveDna = async (spreadsheetId: string) => {
    const res = await app.request(`/clients/${NO_SHEET_CLIENT}/dna`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...kaaeDna, clientId: NO_SHEET_CLIENT, code: 'NOSHEETN', name: 'No Sheet Notify Client', destinations: { ...kaaeDna.destinations, spreadsheetId } }),
    });
    expect(res.status).toBe(201);
  };
  await saveDna('');

  // A request from a Telegram chat, which the notification goes back to (a Desk task has no chat, and
  // Postgres's outbox writes no notification for one), then routed to the client.
  const created = await (await app.request('/api/webhooks/telegram', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'expected_office_secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 5000 + Math.floor(Math.random() * 1e6), message: { text: 'Delivery <notice> & files', chat: { id: REQUESTER_CHAT } } }),
  })).json();
  const taskId: string = created.id || created.task?.id;
  const routed = await app.request(`/tasks/${taskId}/route`, { method: 'POST', headers: auth, body: JSON.stringify({ clientId: NO_SHEET_CLIENT, reason: 'Client assigned' }) });
  expect(routed.status).toBe(202);
  const rev = await (
    await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'Delivery' }] } }),
    })
  ).json();
  // Postgres approves only a revision with a passing critical QA run on record.
  expect((await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/qa`, { method: 'POST' })).status).toBe(200);
  const exportId = exports.add(taskId, 'png');
  const approve = await app.request(`/tasks/${taskId}/revisions/${rev.revisionId}/decisions`, {
    method: 'POST',
    headers: { ...auth, Authorization: 'Bearer test_art_director_bearer' },
    body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exportId] }),
  });
  expect(approve.status).toBe(201);

  const notifications = async () =>
    ((await (await app.request(`/tasks/${taskId}/outbox`, { headers: auth })).json()).commands || [])
      .filter((c: any) => c.commandType === 'notify.published');
  const deliver = () => app.request(`/tasks/${taskId}/publish`, { method: 'POST', headers: auth, body: '{}' });
  return { app, taskId, exportId, saveDna, deliver, notifications };
}

describe('the delivery notification', () => {
  it('is written once the files are in Drive, with the Sheets outcome reported separately', async () => {
    const { deliver, notifications, exportId, taskId } = await setup();

    const first = await (await deliver()).json();
    expect(first.status).toBe('PUBLISH_RECONCILIATION');

    const [notify, ...rest] = await notifications();
    expect(rest).toHaveLength(0);
    expect(notify).toBeDefined();
    expect(notify.payload).toMatchObject({
      taskId,
      // The chat intake's title, which carries the message text as sent.
      title: expect.stringContaining('Delivery <notice> & files'),
      chatId: String(REQUESTER_CHAT),
      sheetsConfirmed: false,
      sheetProblem: 'No spreadsheet is configured for this client',
      sheetRowNumber: null,
      filesCount: 1,
    });
    expect(notify.payload.files).toHaveLength(1);
    expect(notify.payload.files[0]).toMatchObject({ artifactId: exportId, format: 'png', mimeType: 'image/png' });
    expect(notify.payload.files[0].webViewLink).toMatch(/^https:\/\//);
  });

  it('is not written a second time when a retry later confirms the Sheets row', async () => {
    const { deliver, notifications, saveDna } = await setup();
    expect((await (await deliver()).json()).status).toBe('PUBLISH_RECONCILIATION');
    await saveDna('sheet-for-no-sheet-notify-client');
    expect((await (await deliver()).json()).status).toBe('COMPLETE');
    expect(await notifications()).toHaveLength(1);
  });
});

describe('buildDeliveredNotificationPayload', () => {
  const artifactId = crypto.randomUUID();
  const packaged = { artifactId, filename: 'kaae-1234.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64), byteSize: 900 };

  it('names each verified file with its own Drive link and the pinned format', () => {
    const payload = buildDeliveredNotificationPayload({
      taskId: 't1',
      chatId: '555',
      publicationKey: 'pub_key_t1_a1',
      driveFolderId: 'root-folder',
      receipt: {
        state: 'complete',
        driveFiles: [{ artifactId, fileId: 'drive-file-9', verified: true, webViewLink: 'https://drive.google.com/file/d/drive-file-9/view?usp=x' }],
        sheet: { rowNumber: 12, synced: true },
      },
      pins: [{ artifactId, format: 'pdf', sha256: packaged.sha256, byteSize: 900 }],
      files: [packaged],
    });
    expect(payload).toMatchObject({ chatId: '555', sheetsConfirmed: true, sheetRowNumber: 12, sheetProblem: null, filesCount: 1 });
    expect(payload!.files[0]).toEqual({
      artifactId,
      format: 'pdf',
      filename: 'kaae-1234.pdf',
      mimeType: 'application/pdf',
      sha256: packaged.sha256,
      byteSize: 900,
      driveFileId: 'drive-file-9',
      webViewLink: 'https://drive.google.com/file/d/drive-file-9/view?usp=x',
    });
  });

  it('announces nothing when Drive verified no file', () => {
    expect(buildDeliveredNotificationPayload({
      taskId: 't1', chatId: '555', publicationKey: 'k', driveFolderId: 'f',
      receipt: { state: 'drive_complete', driveFiles: [{ artifactId, fileId: 'x', verified: false }] },
      files: [packaged],
    })).toBeNull();
  });

  it('uses one key per publication', () => {
    expect(deliveredNotificationKey('t1', 'pub_key_t1_a1')).toBe('notify_pub_t1_pub_key_t1_a1');
  });
});

describe('the requester chat', () => {
  it('is the Telegram chat the request came from, and nothing else', async () => {
    expect(requesterChatFromIntake({ payload: { sourcePlatform: 'telegram', sourceChannelId: 777 } })).toBe('777');
    expect(requesterChatFromIntake({ sourcePlatform: 'telegram', sourceChannelId: '888' })).toBe('888');
    expect(requesterChatFromIntake({ payload: { sourcePlatform: 'telegram', sourceChannelId: 'tg_default' } })).toBeNull();
    expect(requesterChatFromIntake({ payload: { sourcePlatform: 'hawa_desk', sourceChannelId: 'hawa_desk' } })).toBeNull();
    expect(await resolveRequesterChat({ sourcePlatform: 'telegram', sourceChannelId: '999' })).toBe('999');
    expect(await resolveRequesterChat({ sourcePlatform: 'hawa_desk' }, async () => ({ payload: { sourcePlatform: 'telegram', sourceChannelId: '111' } }))).toBe('111');
    expect(await resolveRequesterChat({ sourcePlatform: 'hawa_desk' }, async () => { throw new Error('db down'); })).toBeNull();
  });
});
