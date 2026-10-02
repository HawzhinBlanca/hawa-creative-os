import {beforeAll as prepareDna} from 'vitest';
import {persistClientDnaFixture} from './fixtures/persisted-client-dna.js';
import {createApp as dnaFixtureCore} from '../src/app.js';
import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, withRlsContext } from '@hawa/db';
import { signActionLink } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Revisions, decisions, feedback, comments and what a delivery left are Postgres's alone
 * (architecture programme 1.3, SPLIT_PLAN.md section 7, groups G3 and G5). Core used to keep them in
 * maps as well and read the maps first, so a restart lost them and a second Core process never saw
 * them. Each test below records something in one app and reads it back from another app on the same
 * database, which is what a restart or a second replica is.
 */

const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/** KAAE's seeded client row; its fixture DNA names a Drive folder. */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const TENANT = '00000000-0000-4000-a000-000000000001';
const json = { 'Content-Type': 'application/json' };
const artDirector = { ...json, Authorization: 'Bearer test_art_director_bearer' };

/** A QA engine whose every run passes: the subject here is where the state lives, not QA. */
const passingQa = {
  run: async (_ctx: unknown, input: { designRevisionId: string }) => ({
    ok: true as const,
    value: { qcRunId: crypto.randomUUID(), revisionId: input.designRevisionId, status: 'passed', criticalPass: true, findings: [], profile: 'strict' },
  }),
};

/** Two Core processes on one database, sharing one export store (the Canva exports live outside Core). */
function twoProcesses() {
  const exports = memoryExportStore();
  const make = () =>
    createAppWithClientFixtures({ db: testDb, testAuth: { principal: { role: 'art_director' }, roleHeader: true }, deliverableStore: exports.store, qaEngine: passingQa as never });
  return { exports, a: make(), b: make() };
}

type App = ReturnType<typeof createApp>;

async function newTask(app: App, title: string): Promise<string> {
  const res = await app.request('/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title, clientId: KAAE }) });
  expect(res.status).toBe(201);
  const created = await res.json();
  return created.id || created.task?.id;
}

async function newRevision(app: App, taskId: string, text: string): Promise<string> {
  const res = await app.request(`/tasks/${taskId}/revisions`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      document: { id: `doc_${text}`, pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'headline', type: 'text', text }] },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).revisionId;
}

/** A task whose revision is approved with one pinned export, recorded through app `a`. */
async function approvedTask(a: App, exports: ReturnType<typeof memoryExportStore>) {
  const taskId = await newTask(a, 'Accreditation announcement');
  const revisionId = await newRevision(a, taskId, 'KAAE accreditation');
  expect((await a.request(`/tasks/${taskId}/revisions/${revisionId}/qa`, { method: 'POST' })).status).toBe(200);
  const approved = await a.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
    method: 'POST',
    headers: artDirector,
    body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exports.add(taskId)] }),
  });
  expect(approved.status).toBe(201);
  return { taskId, revisionId };
}

describe('design revisions are read from design_revisions', () => {
  it('another process lists, diffs, checks and reviews revisions it never saw submitted', async () => {
    const { a, b } = twoProcesses();
    const taskId = await newTask(a, 'Two revisions');
    const first = await newRevision(a, taskId, 'First headline');
    const second = await newRevision(a, taskId, 'Second headline');

    const listed = await (await b.request(`/designs/${taskId}/revisions`)).json();
    expect(listed.items.map((r: { revisionId: string }) => r.revisionId)).toEqual([first, second]);

    const diff = await b.request(`/tasks/${taskId}/revisions/diff?fromRevisionId=${first}&toRevisionId=${second}`);
    expect(diff.status).toBe(200);
    expect((await diff.json()).diff).toBeDefined();

    expect((await b.request(`/tasks/${taskId}/revisions/${second}/qa`, { method: 'POST' })).status).toBe(200);

    const desk = await (await b.request(`/tasks/${taskId}/review-desk?revisionId=${second}`, { headers: artDirector })).json();
    expect(desk.exactCopy.map((c: { text: string }) => c.text)).toContain('Second headline');
  });
});

describe('a revision is answered only under its own task', () => {
  it('QA and diff refuse a revision of another task', async () => {
    const { a } = twoProcesses();
    const first = await newTask(a, 'Owner');
    const revisionOfFirst = await newRevision(a, first, 'Owner headline');
    const second = await newTask(a, 'Other');
    const revisionOfSecond = await newRevision(a, second, 'Other headline');

    expect((await a.request(`/tasks/${second}/revisions/${revisionOfFirst}/qa`, { method: 'POST' })).status).toBe(404);
    const runs = await withRlsContext(testDb, { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (trx) =>
      trx.selectFrom('qc_runs').select('id').where('design_revision_id', '=', revisionOfFirst).execute()
    );
    expect(runs).toEqual([]);

    const diff = await a.request(`/tasks/${second}/revisions/diff?fromRevisionId=${revisionOfFirst}&toRevisionId=${revisionOfSecond}`);
    expect(diff.status).toBe(404);
  });
});

describe('review decisions are recorded in approvals or not at all', () => {
  it('without a database, no revision is taken and nothing is approved', async () => {
    const app = createApp({ testAuth: { principal: { role: 'art_director' }, roleHeader: true } });
    const created = await (await app.request('/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'No database', clientId: KAAE }) })).json();
    const taskId: string = created.id || created.task?.id;

    const revision = await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'x' }] } }),
    });
    expect(revision.status).toBe(503);

    const decision = await app.request(`/tasks/${taskId}/revisions/${crypto.randomUUID()}/decisions`, {
      method: 'POST',
      headers: artDirector,
      body: JSON.stringify({ decision: 'approved', role: 'art_director' }),
    });
    expect(decision.status).toBe(503);
    expect((await (await app.request(`/tasks/${taskId}`)).json()).status).not.toBe('APPROVED');
  });
});

describe('operator feedback is recorded in feedback_events', () => {
  it('stores the feedback against the task\'s own client, whatever client the body names', async () => {
    const { a } = twoProcesses();
    const taskId = await newTask(a, 'Feedback');
    const revisionId = await newRevision(a, taskId, 'Feedback headline');

    const res = await a.request(`/tasks/${taskId}/feedback`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ comment: 'Make the logo larger', polarity: 'negative', category: 'logo', revisionId, clientId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(201);
    const { feedback } = await res.json();

    const rows = await withRlsContext(testDb, { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (trx) =>
      trx.selectFrom('feedback_events').select(['id', 'client_id', 'comment', 'category', 'before_revision_id']).where('task_id', '=', taskId).execute()
    );
    expect(rows).toEqual([{ id: feedback.feedbackId, client_id: KAAE, comment: 'Make the logo larger', category: 'logo', before_revision_id: revisionId }]);
  });
});

describe('what a delivery left is read from publications', () => {
  it('another process answers the receipt and the state of a delivery it did not make', async () => {
    const { exports, a, b } = twoProcesses();
    const { taskId } = await approvedTask(a, exports);
    const delivered = await a.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(delivered.status).toBe(200);
    const { publicationReceipt } = await delivered.json();

    const receipt = await b.request(`/tasks/${taskId}/publication-receipt`);
    expect(receipt.status).toBe(200);
    const stored = (await receipt.json()).receipt;
    expect(stored).toMatchObject({ publicationId: publicationReceipt.publicationId, state: 'complete', recordedIn: 'postgres' });
    expect(stored.driveFiles.map((f: { fileId: string }) => f.fileId)).toEqual(publicationReceipt.driveFiles.map((f: { fileId: string }) => f.fileId));

    const state = await (await b.request(`/tasks/${taskId}/publication-state`, { headers: artDirector })).json();
    expect(state.driveFiles).toEqual({ verified: true, count: 1 });

    // Pressing publish again in the other process answers from the stored publication, uploading nothing.
    const again = await b.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(again.status).toBe(200);
    const stored2 = await again.json();
    expect(stored2.publicationReceipt.publicationId).toBe(publicationReceipt.publicationId);
    // Marked as a stored answer, like one adopted in the delivery itself, so it is never counted as a
    // second delivery.
    expect(stored2.alreadyCompleted).toBe(true);
    expect(stored2.publicationReceipt.detail.alreadyCompleted).toBe(true);
  });

  it('an approve from chat on a delivered task answers with the stored delivery, not a conflict', async () => {
    const { exports, a, b } = twoProcesses();
    const { taskId } = await approvedTask(a, exports);
    const delivered = await a.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
    expect(delivered.status).toBe(200);
    const { publicationReceipt } = await delivered.json();

    // Before the receipts moved to Postgres the process that delivered answered from its map; the
    // task is COMPLETE, so moving it to PUBLISHING again fails with 409 unless the row answers first.
    const claims = { taskId, action: 'approve' as const, publish: true, exp: Math.floor(Date.now() / 1000) + 3600 };
    const sig = signActionLink(claims);
    const query = new URLSearchParams({ taskId, action: 'approve', publish: 'true', exp: String(claims.exp), sig });
    // Opening the link only asks for confirmation (ADR-159); the confirmation's form post acts.
    const opened = await b.request(`/api/webhooks/whatsapp/actions?${query}`, { method: 'GET' });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('<form method="POST"');
    const res = await b.request('/api/webhooks/whatsapp/actions', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: query.toString() });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('drive.google.com/drive/folders/');
    const post = await b.request('/api/webhooks/whatsapp/actions', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...claims, sig }),
    });
    expect(post.status).toBe(200);
    const answer = (await post.json()).publishRes;
    expect(answer).toMatchObject({ alreadyCompleted: true, status: 'COMPLETE' });
    expect(answer.publicationReceipt.publicationId).toBe(publicationReceipt.publicationId);
    expect((await (await b.request(`/tasks/${taskId}`)).json()).status).toBe('COMPLETE');
  });

  it('two presses at once deliver once: the other is told to retry or answered from the stored delivery', async () => {
    const { exports, a } = twoProcesses();
    const { taskId } = await approvedTask(a, exports);
    const presses = await Promise.all([0, 1].map(async () => {
      const res = await a.request(`/tasks/${taskId}/publish-omnichannel`, { method: 'POST', headers: json });
      return { status: res.status, body: await res.json() };
    }));
    // A press that delivered answers with a fresh receipt; one that joined a running delivery in this
    // process used to answer with the same fresh receipt, as if it had delivered too.
    const fresh = presses.filter((p) => p.status === 200 && p.body.publicationReceipt?.detail?.alreadyCompleted !== true);
    expect(fresh).toHaveLength(1);
    for (const other of presses.filter((p) => p !== fresh[0])) {
      if (other.status === 200) expect(other.body.publicationReceipt.detail.alreadyCompleted).toBe(true);
      else expect(other).toMatchObject({ status: 409 });
    }
  });

  it('without a database there is no outbox to list: the answer is 503, not an empty queue', async () => {
    const app = createApp({ testAuth: { principal: { role: 'art_director' }, roleHeader: true } });
    const created = await (await app.request('/tasks', { method: 'POST', headers: json, body: JSON.stringify({ title: 'No outbox', clientId: KAAE }) })).json();
    const taskId: string = created.id || created.task?.id;
    expect((await app.request(`/tasks/${taskId}/outbox`, { headers: artDirector })).status).toBe(503);
    expect((await app.request(`/tasks/${taskId}/publication-state`, { headers: artDirector })).status).toBe(503);
  });
});

describe('reviewer comments are recorded in review_comments', () => {
  it('another process lists a comment, attributed to the signed-in reviewer', async () => {
    const { a, b } = twoProcesses();
    const taskId = await newTask(a, 'Comments');
    const revisionId = await newRevision(a, taskId, 'Commented headline');

    const posted = await a.request(`/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ revisionId, nodeId: 'headline', comment: 'Larger, please', author: { role: 'art_director', userId: 'someone-else', displayName: 'AD' } }),
    });
    expect(posted.status).toBe(201);
    const { comment } = await posted.json();
    expect(comment).toMatchObject({ taskId, revisionId, nodeId: 'headline', comment: 'Larger, please', author: { role: 'art_director', displayName: 'AD' } });
    // The author is whoever is signed in; the body used to name any user it liked.
    expect(comment.author.userId).not.toBe('someone-else');

    const listed = await (await b.request(`/tasks/${taskId}/comments`)).json();
    expect(listed.comments).toEqual([comment]);
  });

  it('records the signed-in caller\'s role, not the role the body claims', async () => {
    const { a } = twoProcesses();
    const taskId = await newTask(a, 'Comment roles');
    const asOperator = await a.request(`/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { ...json, 'x-user-role': 'operator' },
      body: JSON.stringify({ comment: 'Operator note', author: { role: 'art_director' } }),
    });
    expect(asOperator.status).toBe(201);
    expect((await asOperator.json()).comment.author.role).toBe('operator');

    const asGuest = await a.request(`/tasks/${taskId}/comments`, {
      method: 'POST',
      headers: { ...json, 'x-user-role': 'external_guest' },
      body: JSON.stringify({ comment: 'Guest note', author: { role: 'art_director' } }),
    });
    expect(asGuest.status).toBe(403);
    expect((await (await a.request(`/tasks/${taskId}/comments`)).json()).comments).toHaveLength(1);
  });

  it('refuses a comment on another task\'s revision', async () => {
    const { a } = twoProcesses();
    const first = await newTask(a, 'First');
    const revisionOfFirst = await newRevision(a, first, 'First headline');
    const second = await newTask(a, 'Second');
    const res = await a.request(`/tasks/${second}/comments`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ revisionId: revisionOfFirst, comment: 'Wrong task', author: { role: 'art_director' } }),
    });
    expect(res.status).toBe(404);
    expect((await (await a.request(`/tasks/${second}/comments`)).json()).comments).toEqual([]);
  });
});

prepareDna(async()=>{await persistClientDnaFixture(dnaFixtureCore({db:testDb}), 'c1000000-0000-4000-8000-000000000002',{Authorization:`Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}`});});
