/**
 * ADR-230 addendum (live test 2026-10-01, L8): a change sent while the design is being made is applied.
 *
 * Request ab48fb97: "also please add that seats are limited" at 13:59 while it was `designing`; the
 * requester was told "I've added that"; the draft finished at 14:00 without it and went to office review,
 * and the office's draft alert did not mention it. Played here through the worker's ChatInbox, Core's
 * intake and design-outcome routes, TelegramSender and RequestLifecycle (fixtures/conversation-harness.ts).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { ConversationHarness, type Person } from './fixtures/conversation-harness.js';
import { Play } from './fixtures/conversation-script.js';
import { KAAE_EVENING } from './fixtures/nl-scripts/briefs.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { MAX_PENDING_ROUNDS } from '../src/services/lifecycle-pending-round.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const WORKER = ['pending', 'round', 'worker', 'fixture'].join('_');
const tenantId = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const LIVE_WORDS = 'also please add that seats are limited';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); await owner.destroy(); });

let seed = 93_900_000 + Math.floor(Math.random() * 90_000) * 10;
function play() {
  seed += 10;
  const office: Person[] = [{ id: seed + 1, name: 'Office A' }, { id: seed + 2, name: 'Office B' }];
  const h = new ConversationHarness({ db, owner, office, workerToken: WORKER });
  return { p: new Play(h, office, 'private'), h, office };
}
const requestRow = async (requestId: string) => (await withRlsContext(db, scope, (trx) => sql<{ stage: string; rev: string; current_task_id: string }>`
  SELECT stage, rev, current_task_id::text FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(trx))).rows[0];
const taskOf = async (taskId: string) => (await withRlsContext(db, scope, (trx) => sql<{ state: string; options: Record<string, unknown> }>`
  SELECT t.state, o.payload->'studioOptions' AS options FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id
    AND o.command_type = 'task.created' WHERE t.id = ${taskId}::uuid`.execute(trx))).rows[0];
const pending = (requestId: string) => withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId));

describe('a change sent while the design is being made (ADR-230 addendum, L8)', () => {
  it('the live words: the first draft is not reviewed, the next round starts with them, and the requester is told so', async () => {
    const { p, h, office } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.wait(30_000);
    const requestId = p.request();
    const firstTask = (await requestRow(requestId)).current_task_id;
    await p.say(LIVE_WORDS, { after: 60_000 });
    expect(p.kept).toHaveLength(1);
    expect(await pending(requestId)).toHaveLength(1);
    await p.draftReady();
    // The next round, on a child task of the draft, with the requester's words as its change.
    const designs = h.t.designs.filter((d) => d.requestId === requestId);
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({ round: 1 });
    expect(designs[1].taskId).not.toBe(firstTask);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'designing', rev: '2', current_task_id: designs[1].taskId });
    expect(await taskOf(firstTask)).toMatchObject({ state: 'revision_requested' });
    expect((await taskOf(designs[1].taskId)).options).toMatchObject({ parentTaskId: firstTask, revisionRound: 1, revisionDirective: LIVE_WORDS });
    // The stale draft went to nobody in the office; the change is no longer waiting to be read.
    for (const member of office) expect(h.alertFor(member, requestId)).toBeUndefined();
    expect(await pending(requestId)).toHaveLength(0);
    // ADR-232 addendum: the brief's closing "Please make a poster." is a request, not copy, so its copy is
    // taken apart and the title is the headline, uncut.
    expect(p.said.at(-1)?.text).toBe("Your first draft of <b>KAAE members evening</b> is done. I'm now adding what you asked while it was being made: " +
      '“also please add that seats are limited”. The office checks the new version before it comes to you.');
    // The new round's draft goes to review as any revised draft does, and starts nothing more.
    await p.draftReady();
    expect(h.t.designs.filter((d) => d.requestId === requestId)).toHaveLength(2);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'in_review', rev: '3' });
    expect(h.alertFor(office[0], requestId)).toBeDefined();
  });

  it('is replay-safe: the finished run reported again starts no second round and sends nothing twice', async () => {
    const { p, h } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.wait(30_000);
    const requestId = p.request();
    await p.say(LIVE_WORDS, { after: 60_000 });
    await p.draftReady();
    const sent = h.t.sent.length;
    const rounds = await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*) AS n FROM hawa.lifecycle_projections
      WHERE request_id = ${requestId}::uuid AND result ? 'pendingRound'`.execute(trx));
    await h.replayDesignFinished(requestId, 0);
    // The same run is started again under the same workflow key (Restate runs it once); Core recorded nothing new.
    expect(new Set(h.t.designs.filter((d) => d.requestId === requestId).map((d) => d.runId)).size).toBe(2);
    expect(h.t.sent.length).toBe(sent);
    expect((await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*) AS n FROM hawa.lifecycle_projections
      WHERE request_id = ${requestId}::uuid AND result ? 'pendingRound'`.execute(trx))).rows[0].n).toBe(rounds.rows[0].n);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'designing', rev: '2' });
  });

  it('with the day\'s allowance used up: the draft goes to review, the office alert quotes the change, the requester is told the office has it', async () => {
    const { p, h, office } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.wait(30_000);
    const requestId = p.request();
    await p.say(LIVE_WORDS, { after: 60_000 });
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '1');
    await p.draftReady();
    expect(h.t.designs.filter((d) => d.requestId === requestId)).toHaveLength(1);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'in_review', rev: '2' });
    const toOffice = h.t.sent.filter((s) => s.chatId === String(office[0].id) && s.key.includes(':office-alert'));
    expect(toOffice).toHaveLength(1);
    expect(toOffice[0].text).toContain('NOT IN THIS DRAFT');
    expect(toOffice[0].text).toContain(`“${LIVE_WORDS}”`);
    expect(toOffice[0].text).toContain('the automatic design allowance for today is used up');
    expect(p.said.at(-1)?.text).toBe('Your draft of <b>KAAE members evening</b> was finished before your changes could be added: ' +
      '“also please add that seats are limited”. The office has them and will see to them before the design comes to you.');
    // Still unread: Deliver waits until an office member has read it.
    expect(await pending(requestId)).toHaveLength(1);
  });

  it(`after ${MAX_PENDING_ROUNDS} such rounds a person takes over: the next draft goes to review with the change quoted`, async () => {
    const { p, h, office } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.wait(30_000);
    const requestId = p.request();
    for (let round = 1; round <= MAX_PENDING_ROUNDS; round++) {
      await p.say(`also add line ${round}`, { after: 60_000 });
      await p.draftReady();
      expect(await requestRow(requestId)).toMatchObject({ stage: 'designing' });
    }
    await p.say('also add the last line', { after: 60_000 });
    await p.draftReady();
    expect(h.t.designs.filter((d) => d.requestId === requestId)).toHaveLength(MAX_PENDING_ROUNDS + 1);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'in_review' });
    const alert = h.t.sent.filter((s) => s.chatId === String(office[0].id) && s.key.includes(':office-alert')).at(-1);
    expect(alert?.text).toContain('“also add the last line”');
    expect(alert?.text).toContain(`already had ${MAX_PENDING_ROUNDS} automatic rounds`);
  });

  it('a draft with no change sent while it was made goes to review as before', async () => {
    const { p, h, office } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.draftReady();
    expect(await requestRow(p.request())).toMatchObject({ stage: 'in_review', rev: '2' });
    expect(h.alertFor(office[0], p.request())).toBeDefined();
    expect(h.t.designs).toHaveLength(1);
  });
});
