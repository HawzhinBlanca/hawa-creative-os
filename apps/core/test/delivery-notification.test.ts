import {beforeAll as prepareDna} from 'vitest';
import {activeDnaVersion,persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import {createApp as dnaFixtureCore} from '../src/app.js';
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
 * Core's own delivery sends nothing to a requester (ADR-135 stage 2d): the request-owned Delivery
 * workflow sends the approved files to a Telegram requester, and a Telegram task outside
 * RequestLifecycle is refused before any effect (delivery-without-drive.test.ts). Until stage 2d
 * Core wrote a `notify.published` command once the files were verified in Drive. The payload
 * helpers below stay: the workflow's answer is built with them.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
// FastPay's seeded client row, given KAAE's DNA without a spreadsheet: Postgres keeps DNA only
// for a client it holds.
const NO_SHEET_CLIENT = 'c1000000-0000-4000-8000-000000000004';
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
      body: JSON.stringify({ ...kaaeDna, clientId: NO_SHEET_CLIENT, code: 'NOSHEETN', name: 'No Sheet Notify Client', destinations: { ...kaaeDna.destinations, spreadsheetId },
        expectedVersion: await activeDnaVersion(app, NO_SHEET_CLIENT, auth, '') }),
    });
    expect(res.status).toBe(201);
  };
  await saveDna('');

  // A Desk task for the client: the only kind of task Core's own delivery still delivers.
  const created = await (await app.request('/tasks', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'Delivery <notice> & files', clientId: NO_SHEET_CLIENT }),
  })).json();
  const taskId: string = created.id || created.task?.id;
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

describe("Core's own delivery", () => {
  it('writes no requester notification once the files are in Drive, with the Sheets outcome still reported', async () => {
    const { deliver, notifications } = await setup();

    const first = await (await deliver()).json();
    // No spreadsheet: the archive is written and the ledger row is left for reconciliation.
    expect(first.status).toBe('PUBLISH_RECONCILIATION');
    expect(await notifications()).toHaveLength(0);
  });

  it('writes none either when a retry later confirms the Sheets row and completes the task', async () => {
    const { deliver, notifications, saveDna } = await setup();
    expect((await (await deliver()).json()).status).toBe('PUBLISH_RECONCILIATION');
    await saveDna('sheet-for-no-sheet-notify-client');
    expect((await (await deliver()).json()).status).toBe('COMPLETE');
    expect(await notifications()).toHaveLength(0);
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

prepareDna(async()=>{await persistClientDnaFixture(dnaFixtureCore({db:testDb}), 'c1000000-0000-4000-8000-000000000002',{Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`});});
