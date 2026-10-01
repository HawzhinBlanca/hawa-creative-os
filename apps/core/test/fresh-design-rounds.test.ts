/**
 * ADR-233 (live test 2026-10-01, L13): a redo and a round for changes sent while the first draft was
 * being made are new designs of their request, not native edits of the earlier design.
 *
 * 15:09:58 the owner replied to the delivered KAAE K-12 design: "do a better design that's similar to
 * the earlier ones, use more of the photos arranged creatively, not the same plain background". The
 * round started (ADR-200 §6), and ADR-113's guard refused it before any spend, because every round
 * named its parent as a native revision. The owner heard "I'll redo …" and, the same second, "A designer
 * will make this change … by hand", and the office and the owner's own chat got "Automatic design needs
 * an operator in Hawa Desk. Task …: DESIGN_REJECTED (NATIVE_REVISION_HANDOFF_REQUIRED)."
 *
 * Nothing is mocked at the design-run boundary: every round the conversation starts meets Core's real
 * admission guard (the harness's DesignRun stand-in), and the rounds are then admitted, or refused, by
 * the real DesignStudioService and CanvaDesignPlanner against the test database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { freshRoundIntent, nativeRevisionIntent } from '@hawa/domain';
import { ConversationHarness, type Person } from './fixtures/conversation-harness.js';
import { Play } from './fixtures/conversation-script.js';
import { KAAE_EVENING } from './fixtures/nl-scripts/briefs.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { CanvaDesignPlanner } from '../src/services/canva-design-planner.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { assertNativeRevisionAdmission } from '../src/services/native-revision-handoff.js';
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { planPendingCopyChanges } from '../src/services/fresh-round-copy.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const WORKER = ['fresh', 'round', 'worker', 'fixture'].join('_');
const tenantId = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: actorId, role: 'operator' as const };
const studioScope = { tenantId, actorId, role: 'operator' };
const LIVE_REDO = "do a better design that's similar to the earlier ones, use more of the photos arranged creatively, not the same plain background";
const LIVE_L8 = 'also please add that seats are limited';
// What a requester must never be shown: an operator code, a task id, the Desk.
const OPERATOR_WORDS = /[A-Z]{3,}_[A-Z_]{3,}|[0-9a-f]{8}-[0-9a-f]{4}-|Hawa Desk|Desk search/;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); await owner.destroy(); });

let seed = 95_100_000 + Math.floor(Math.random() * 90_000) * 10;
function play(options: Partial<ConstructorParameters<typeof ConversationHarness>[0]> = {}) {
  seed += 10;
  const office: Person[] = [{ id: seed + 1, name: 'Office A' }, { id: seed + 2, name: 'Office B' }];
  const h = new ConversationHarness({ db, owner, office, workerToken: WORKER, reportRefusals: true, ...options });
  return { p: new Play(h, office, 'private'), h, office };
}

/** No provider is reached: admission is all these tests ask of the Studio and the planner. */
const noProvider = vi.fn<typeof fetch>(async () => { throw new Error('SYNTHETIC_NO_PROVIDER'); });
const canva = () => new CanvaConnectService(db, { clientId: 'synthetic', clientSecret: 'synthetic', encryptionKey: 'a1'.repeat(32),
  redirectUri: 'http://localhost:8772/v1/integrations/canva/callback', fetcher: noProvider });
const studio = () => new DesignStudioService(db, canva(), { apiKey: 'synthetic', fetcher: noProvider });

/** The real Studio's admission of a task's design run; the run is then set aside so the next test has a slot. */
async function studioAdmits(taskId: string) {
  const { run, created } = await studio().createOrGetRun(studioScope, taskId, `adr233-${randomUUID().slice(0, 12)}`, { width: 1080, height: 1350 });
  await sql`UPDATE hawa.design_studio_runs SET status = 'abandoned' WHERE id = ${run.id}::uuid`.execute(owner);
  return { run, created, request: (typeof run.request === 'string' ? JSON.parse(run.request) : run.request) as Record<string, any> };
}
/** The planner's admission (the older route): its code when refused before any spend, else 'admitted'. */
async function plannerAdmission(taskId: string): Promise<string> {
  try {
    await new CanvaDesignPlanner(db, canva(), { apiKey: 'synthetic', fetcher: noProvider }).generate(studioScope, taskId, `adr233-${randomUUID().slice(0, 12)}`, 1080, 1350);
    return 'admitted';
  } catch (error: any) {
    return error?.code === 'NATIVE_REVISION_HANDOFF_REQUIRED' ? error.code : 'admitted';
  }
}
const guard = (taskId: string) => withRlsContext(db, scope, (trx) => assertNativeRevisionAdmission(trx, tenantId, taskId))
  .then(() => 'admitted', (error: { code?: string }) => error?.code ?? String(error));

const created = async (taskId: string) => (await sql<{ payload: Record<string, any> }>`SELECT payload FROM hawa.outbox_commands
  WHERE aggregate_id = ${taskId}::uuid AND command_type = 'task.created'`.execute(owner)).rows[0].payload;
const requestRow = async (requestId: string) => (await sql<{ stage: string; rev: string; current_task_id: string }>`
  SELECT stage, rev, current_task_id::text FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(owner)).rows[0];
const taskRow = async (taskId: string) => (await sql<{ state: string; version: string }>`SELECT state, version FROM hawa.tasks
  WHERE id = ${taskId}::uuid`.execute(owner)).rows[0];
const bindings = async (taskId: string) => (await sql<{ id: string; canva_design_id: string; version: string; status: string }>`
  SELECT id::text, canva_design_id, version, status FROM hawa.canva_bindings WHERE task_id = ${taskId}::uuid ORDER BY id`.execute(owner)).rows;
const studioRuns = async (taskId: string) => (await sql<{ id: string }>`SELECT id FROM hawa.design_studio_runs
  WHERE task_id = ${taskId}::uuid`.execute(owner)).rows.length;

/** Sewa's design, made, approved and delivered; its current task and Canva binding. */
async function deliveredDesign(p: Play) {
  await p.say(KAAE_EVENING);
  await p.draftReady(0);
  await p.delivered(0);
  const requestId = p.request(0);
  const parentTaskId = (await requestRow(requestId)).current_task_id;
  return { requestId, parentTaskId };
}

describe('a redo is a fresh design of its request (ADR-233, L13)', () => {
  it('the live redo words after delivery: admitted by the Studio and the planner as a new design; the delivered design is untouched', async () => {
    const { p, h } = play();
    const { requestId, parentTaskId } = await deliveredDesign(p);
    const parentBinding = await bindings(parentTaskId);
    const parentTask = await taskRow(parentTaskId);
    expect(parentBinding).toHaveLength(1);
    const redo = await p.say(LIVE_REDO, { after: 15 * 60_000, replyTo: p.lastBotMessage() });
    expect(p.revisions.map((r) => r.directive)).toEqual([LIVE_REDO]);
    const round = h.t.designs.filter((d) => d.requestId === requestId)[1];
    expect(round.refused).toBeUndefined();
    expect(await requestRow(requestId)).toMatchObject({ stage: 'designing', current_task_id: round.taskId });
    // A fresh intent, never a native one, with the parent's copy and format; the words are art direction.
    const child = await created(round.taskId), parent = await created(parentTaskId);
    expect(child.studioOptions).toMatchObject({ freshFrom: { parentTaskId, kind: 'redo', directive: LIVE_REDO } });
    expect(child.studioOptions).not.toHaveProperty('parentTaskId');
    expect(child.studioOptions).not.toHaveProperty('revisionDirective');
    expect(nativeRevisionIntent(child)).toBeUndefined();
    expect(child.exactCopy).toEqual(parent.exactCopy);
    expect(child.variant ?? null).toEqual(parent.variant ?? null);
    expect(child.designInstructions).toContain(`not text to print: "${LIVE_REDO}"`);
    // The real Studio and planner admit it; the Studio's run is a new design (no directed edit of the parent).
    const admitted = await studioAdmits(round.taskId);
    expect(admitted.created).toBe(true);
    expect(admitted.request).not.toHaveProperty('directed');
    expect(admitted.request.copyBlocks.map((b: { text: string }) => b.text)).not.toContain(LIVE_REDO);
    expect(admitted.request.instructions).toContain(LIVE_REDO);
    expect(await plannerAdmission(round.taskId)).toBe('admitted');
    // The delivered design is never opened or overwritten: same binding, same state, no run of its own.
    expect(await bindings(parentTaskId)).toEqual(parentBinding);
    expect(await taskRow(parentTaskId)).toEqual(parentTask);
    expect(await studioRuns(parentTaskId)).toBe(0);
    expect(await bindings(round.taskId)).toHaveLength(0);
    // One truthful message, once the round had started; nothing contradicts it, nothing for an operator.
    const told = p.h.saidFor(redo);
    expect(told.map((s) => s.text)).toEqual([expect.stringMatching(/^I'll redo <b>KAAE members evening/)]);
    expect(p.words).not.toMatch(/by hand/);
    expect(p.words).not.toMatch(OPERATOR_WORDS);
  });

  it('redo words on a draft the office sent back are a fresh round too (ADR-200 §6\'s table)', async () => {
    const { p, h } = play();
    await p.say(KAAE_EVENING);
    await p.draftReady(0);
    await p.officeReplies('The logo is too small, please check the date too');
    const requestId = p.request(0);
    const parentTaskId = (await requestRow(requestId)).current_task_id;
    const redo = await p.say('do a better design', { after: 120_000 });
    const round = h.t.designs.filter((d) => d.requestId === requestId).at(-1)!;
    expect(round.refused).toBeUndefined();
    expect((await created(round.taskId)).studioOptions).toMatchObject({ freshFrom: { parentTaskId, kind: 'redo', directive: 'do a better design' } });
    expect((await studioAdmits(round.taskId)).created).toBe(true);
    expect(h.saidFor(redo).filter((s) => s.chatId === p.chatId).map((s) => s.text)).toEqual([expect.stringMatching(/^I'll redo /)]);
  });

  it('a replayed decision starts no second round and says nothing twice', async () => {
    const { p, h } = play();
    const { requestId } = await deliveredDesign(p);
    await p.say(LIVE_REDO, { after: 15 * 60_000, replyTo: p.lastBotMessage() });
    const before = { said: p.said.length, request: await requestRow(requestId) };
    await h.replayRequesterDecision(h.decisions.length - 1);
    const runs = h.t.designs.filter((d) => d.requestId === requestId);
    expect(new Set(runs.map((d) => d.taskId)).size).toBe(2);
    // The replayed start is the same admitted fresh round, under the same workflow key.
    expect(runs.slice(1).every((d) => d.refused === undefined && d.taskId === runs[1].taskId && d.runId === runs[1].runId)).toBe(true);
    expect(await requestRow(requestId)).toEqual(before.request);
    expect(p.said.length).toBe(before.said);
    expect(p.said.filter((s) => /^I'll redo/.test(s.text))).toHaveLength(1);
  });

  it('the redo places the request\'s photos: the fresh round reads them from the design it follows', async () => {
    const { p, h } = play();
    await p.album([1, 2, 3], { caption: KAAE_EVENING });
    await p.wait(60_000);
    await p.draftReady(0);
    await p.delivered(0);
    const requestId = p.request(0);
    await p.say('do a better design, use more of the photos', { after: 15 * 60_000, replyTo: p.lastBotMessage() });
    const round = h.t.designs.filter((d) => d.requestId === requestId)[1];
    expect(round?.refused).toBeUndefined();
    const admitted = await studioAdmits(round.taskId);
    expect(admitted.request.fresh).toMatchObject({ kind: 'redo' });
    const images = await (studio() as any).imagesForRun(studioScope, { task_id: round.taskId, request: admitted.request });
    expect(images).toHaveLength(3);
  });

  it('the owner (office member and requester): one message in their chat, and no operator alert', async () => {
    const { h, office } = play();
    const ownerChat = String(office[0].id);
    const p = new Play(h, office, 'private', ownerChat);
    await h.post(ownerChat, office[0], 'text', { text: KAAE_EVENING }, 20_000, 'owner: brief');
    await h.wait(60_000);
    const requestId = p.request(0);
    await h.draftReady(requestId);
    await h.officeSays(office[0], 'send it');
    await h.delivered(requestId);
    const redo = await h.post(ownerChat, office[0], 'text', { text: LIVE_REDO }, 15 * 60_000, 'owner: redo');
    expect(h.t.designs.filter((d) => d.requestId === requestId).at(-1)?.refused).toBeUndefined();
    expect(h.saidFor(redo).map((s) => s.text)).toEqual([expect.stringMatching(/^I'll redo <b>KAAE members evening/)]);
    expect(h.t.sent.filter((s) => s.text.includes('needs an operator') || s.text.includes('has to be made by hand'))).toHaveLength(0);
  });
});

describe('changes sent while the first draft was being made start a fresh round (ADR-233, L8)', () => {
  it('the live words: the round is admitted, and its copy says "seats are limited", taken from the requester\'s words', async () => {
    const { p, h } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.wait(30_000);
    const requestId = p.request();
    const firstTask = (await requestRow(requestId)).current_task_id;
    await p.say(LIVE_L8, { after: 60_000 });
    await p.draftReady();
    const round = h.t.designs.filter((d) => d.requestId === requestId)[1];
    expect(round.refused).toBeUndefined();
    const child = await created(round.taskId), parent = await created(firstTask);
    expect(child.studioOptions).toMatchObject({ freshFrom: { parentTaskId: firstTask, kind: 'pending_changes', directive: LIVE_L8 } });
    expect(child.exactCopy.map((b: { text: string }) => b.text)).toEqual([...parent.exactCopy.map((b: { text: string }) => b.text), 'seats are limited']);
    expect(child.exactCopy.map((b: { text: string }) => b.text)).not.toContain(LIVE_L8);
    const admitted = await studioAdmits(round.taskId);
    expect(admitted.request.copyBlocks.map((b: { text: string }) => b.text)).toContain('seats are limited');
    expect(admitted.request).not.toHaveProperty('directed');
    expect(await plannerAdmission(round.taskId)).toBe('admitted');
    // The unreviewed first draft is superseded, never edited.
    expect(await taskRow(firstTask)).toMatchObject({ state: 'revision_requested' });
    expect(await studioRuns(firstTask)).toBe(0);
    expect(p.said.filter((s) => /I'm now adding what you asked/.test(s.text))).toHaveLength(1);
    expect(p.words).not.toMatch(/by hand/);
    expect(p.words).not.toMatch(OPERATOR_WORDS);
  });

  it('a change to the words that cannot be applied safely starts nothing: the draft goes to review with it listed', async () => {
    const { p, h, office } = play();
    await h.emptyOfficeQueue();
    await p.say(KAAE_EVENING);
    await p.wait(30_000);
    const requestId = p.request();
    await p.say('also change the time to 11:00', { after: 60_000 });
    await p.draftReady();
    expect(h.t.designs.filter((d) => d.requestId === requestId)).toHaveLength(1);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'in_review' });
    const alert = h.t.sent.filter((s) => s.chatId === String(office[0].id) && s.key.includes(':office-alert')).at(-1);
    expect(alert?.text).toContain('NOT IN THIS DRAFT');
    expect(alert?.text).toContain('“also change the time to 11:00”');
    expect(alert?.text).toContain("a change to the design's words could not be applied safely");
    expect(p.said.at(-1)?.text).toMatch(/was finished before your changes could be added/);
  });

  it('reads additions, alterations and art direction, and refuses what it cannot ground', () => {
    const copy = [{ id: 'copy_0', role: 'headline', text: 'Assessment Literacy Workshop', language: 'en', direction: 'ltr', approved: true },
      { id: 'copy_1', role: 'body', text: '15 October 2026 · 10:00 AM', language: 'en', direction: 'ltr', approved: true }];
    const plan = (words: string[]) => planPendingCopyChanges(copy, { copyEn: '15 October 2026 · 10:00 AM' }, words);
    const added = plan([LIVE_L8, 'make the background blue']);
    expect(added).toMatchObject({ ok: true, direction: ['make the background blue'] });
    if (added.ok) expect(added.exactCopy.map((b) => b.text)).toEqual(['Assessment Literacy Workshop', '15 October 2026 · 10:00 AM', 'seats are limited']);
    const altered = plan(['please change 15 October to 16 October']);
    if (!altered.ok) throw new Error(altered.why);
    expect(altered.exactCopy[1].text).toBe('16 October 2026 · 10:00 AM');
    expect(altered.fields.copyEn).toBe('16 October 2026 · 10:00 AM');
    expect(plan(['add "Registration is free"'])).toMatchObject({ ok: true, applied: [{ kind: 'added', text: 'Registration is free' }] });
    expect(plan(['add the logo'])).toMatchObject({ ok: true, direction: ['add the logo'] });
    for (const unsafe of ['add the date', 'change the time to 11:00', 'remove the date line', 'change 20 November to 21 November', 'تکایە کاتەکە بگۆڕە'])
      expect(plan([unsafe]).ok).toBe(false);
  });
});

describe('the ADR-113 handoff and malformed intent are unchanged (ADR-233)', () => {
  it('a requester change after the office sent the draft back is still a native revision: refused, one plain message, the office told in words', async () => {
    const { p, h, office } = play();
    await p.say(KAAE_EVENING);
    await p.draftReady(0);
    await p.officeReplies('The logo is too small, please check the date too');
    const requestId = p.request(0);
    const parentTaskId = (await requestRow(requestId)).current_task_id;
    const change = await p.say('make the logo bigger and the date is 5 December', { after: 120_000 });
    const round = h.t.designs.filter((d) => d.requestId === requestId).at(-1)!;
    expect(round.refused).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
    expect((await created(round.taskId)).studioOptions).toMatchObject({ parentTaskId });
    await expect(studio().createOrGetRun(studioScope, round.taskId, `adr233-${randomUUID().slice(0, 12)}`, { width: 1080, height: 1350 }))
      .rejects.toMatchObject({ code: 'NATIVE_REVISION_HANDOFF_REQUIRED' });
    expect(await plannerAdmission(round.taskId)).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
    expect(await requestRow(requestId)).toMatchObject({ stage: 'manual', current_task_id: round.taskId });
    // One message for the change, after the outcome: no "I'm making those changes now" first.
    const told = h.saidFor(change).filter((s) => s.chatId === p.chatId).map((s) => s.text);
    expect(told).toEqual([expect.stringMatching(/by hand/)]);
    expect(p.words).not.toMatch(/making those changes now/);
    expect(p.words).not.toMatch(OPERATOR_WORDS);
    const alerts = h.t.sent.filter((s) => office.some((m) => String(m.id) === s.chatId) && s.key.startsWith(`${requestId}:`) && s.key.includes(':office-alert'));
    const handoff = alerts.at(-1)!.text;
    expect(handoff).toMatch(/has to be made by hand/);
    expect(handoff).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}|needs an operator/);
    expect(handoff.endsWith(`\nDesk search: ${round.taskId.slice(0, 8)}`)).toBe(true);
  });

  it('refuses a malformed, ambiguous or out-of-scope fresh intent before anything is spent', async () => {
    const { p, h } = play();
    const { requestId, parentTaskId } = await deliveredDesign(p);
    const other = await deliveredDesign(new Play(h, p.office, 'private'));
    const make = async (studioOptions: unknown, request: string | null = requestId) => {
      const id = randomUUID();
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, version, request_id)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${KAAE}::uuid, 'Fresh fixture', '', 'received', 1, ${request}::uuid)`.execute(owner);
      await sql`INSERT INTO hawa.task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data)
        VALUES (${tenantId}::uuid, ${id}::uuid, 'task.created', 1, 'adapter', 'telegram', ${randomUUID()}::uuid,
          ${JSON.stringify({ exactCopy: [{ text: 'KAAE members evening' }], studioOptions })}::jsonb)`.execute(owner);
      return id;
    };
    const directive = 'do a better design';
    const good = await make({ freshFrom: { parentTaskId, kind: 'redo', directive } });
    expect(await guard(good)).toBe('admitted');
    for (const options of [
      { freshFrom: { parentTaskId, kind: 'native', directive } },
      { freshFrom: { parentTaskId, kind: 'redo' } },
      { freshFrom: { parentTaskId, kind: 'redo', directive: '  ' } },
      { freshFrom: { parentTaskId: 'not-a-task', kind: 'redo', directive } },
      { freshFrom: { parentTaskId, kind: 'redo', directive, extra: true } },
      { freshFrom: [parentTaskId] },
      { freshFrom: null },
      // Ambiguous: a native parent beside it stays a native revision.
      { parentTaskId, freshFrom: { parentTaskId, kind: 'redo', directive } },
    ]) {
      const id = await make(options);
      expect(nativeRevisionIntent({ studioOptions: options })).toBeDefined();
      expect(await guard(id)).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
    }
    // A parent outside the task's own request (another requester's design, or the task itself) is refused.
    expect(await guard(await make({ freshFrom: { parentTaskId: other.parentTaskId, kind: 'redo', directive } }))).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
    expect(await guard(await make({ freshFrom: { parentTaskId, kind: 'redo', directive } }, null))).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
    const self = randomUUID();
    expect(freshRoundIntent({ studioOptions: { freshFrom: { parentTaskId: self, kind: 'redo', directive } } })).toBeDefined();
    const malformed = await make({ freshFrom: { parentTaskId, kind: 'redo' } });
    await expect(studio().createOrGetRun(studioScope, malformed, `adr233-${randomUUID().slice(0, 12)}`, { width: 1080, height: 1350 }))
      .rejects.toMatchObject({ code: 'NATIVE_REVISION_HANDOFF_REQUIRED' });
    expect(await plannerAdmission(malformed)).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
  });

  it('an outcome with no draft for a requester who is an office member: one message in their chat, no codes; the other members get plain words', async () => {
    const requesterChat = String(77_000_000 + Math.floor(Math.random() * 8_000_000));
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', `${requesterChat},88880003`);
    const requestId = randomUUID();
    const opened = await projectLifecycleOpen(db, { requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: requesterChat, rawText: 'KAAE K-12 Pilot Study',
        title: 'KAAE: KAAE K-12 Pilot Study', designInstructions: 'A poster.', exactCopy: ['KAAE K-12 Pilot Study'], clientId: KAAE,
        autoGenerate: true, designStudio: true } });
    const runId = `dr-${opened.taskId}`;
    const outcome = await projectLifecycleDesignOutcome(db, { requestId, tenantId, taskId: opened.taskId, runId, expectedRev: 1, rev: 2,
      key: `${requestId}:2:designFinished:${runId}`, report: { status: 'DESIGN_REJECTED', code: 'NATIVE_REVISION_HANDOFF_REQUIRED' } });
    expect(outcome.officeAlerts?.map((a) => a.chatId)).toEqual(['88880003']);
    expect(outcome.officeAlerts?.[0].text).toMatch(/^The change the requester asked for on "KAAE K-12 Pilot Study" has to be made by hand/);
    expect(outcome.officeAlerts?.[0].text).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}|needs an operator/);
    const message = outcome.message!.text;
    expect(message).toMatch(/^A designer will make this change to <b>.*<\/b> by hand/);
    expect(message).toContain('has to be made by hand');
    expect(message).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('recovering a redo that the guard refused before this change (request 95eeb08d)', () => {
  it('the office\'s retry designs it again as a fresh successor; the refused task closes; the delivered design is untouched', async () => {
    // A task the release before ADR-233 made for the redo: its intent named the delivered task as a native revision.
    let made = false;
    const legacy = async (input: { taskId: string }) => {
      const options = (await created(input.taskId)).studioOptions as Record<string, any>;
      if (!options?.freshFrom || made) return;
      made = true;
      const old = { revisionRound: options.revisionRound, parentTaskId: options.freshFrom.parentTaskId, revisionDirective: options.freshFrom.directive };
      await sql`UPDATE hawa.outbox_commands SET payload = jsonb_set(payload, '{studioOptions}', ${JSON.stringify(old)}::jsonb)
        WHERE aggregate_id = ${input.taskId}::uuid AND command_type = 'task.created'`.execute(owner);
      // The creation event is append-only; this file's own database stands in for one an older release wrote.
      await owner.transaction().execute(async (trx) => {
        await sql`ALTER TABLE hawa.task_events DISABLE TRIGGER task_events_append_only`.execute(trx);
        await sql`UPDATE hawa.task_events SET data = CASE WHEN data ? 'payload' THEN jsonb_set(data, '{payload,studioOptions}', ${JSON.stringify(old)}::jsonb)
            ELSE jsonb_set(data, '{studioOptions}', ${JSON.stringify(old)}::jsonb) END
          WHERE task_id = ${input.taskId}::uuid AND event_type = 'task.created'`.execute(trx);
        await sql`ALTER TABLE hawa.task_events ENABLE TRIGGER task_events_append_only`.execute(trx);
      });
    };
    const { p, h } = play({ beforeDesignAdmission: legacy });
    const { requestId, parentTaskId } = await deliveredDesign(p);
    // Production's delivered task is complete (ADR-230's chat-only close); the harness records only the request.
    await sql`UPDATE hawa.tasks SET state = 'complete' WHERE id = ${parentTaskId}::uuid`.execute(owner);
    const parentBinding = await bindings(parentTaskId);
    await p.say(LIVE_REDO, { after: 15 * 60_000, replyTo: p.lastBotMessage() });
    const refused = h.t.designs.filter((d) => d.requestId === requestId)[1];
    expect(refused.refused).toBe('NATIVE_REVISION_HANDOFF_REQUIRED');
    expect(await requestRow(requestId)).toMatchObject({ stage: 'manual', current_task_id: refused.taskId });
    const saidBefore = p.said.length;
    // The office's existing retry (ADR-142), from the Desk, through the signed gateway.
    const retry = () => h.app.request(`/v1/tasks/${refused.taskId}/lifecycle/retry-design`, { method: 'POST',
      headers: { Authorization: 'Bearer test_bearer', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'ADR-233: retry the refused redo as a new design.' }) });
    const first = await retry();
    expect(first.status, await first.clone().text()).toBe(202);
    const body = await first.json() as { freshTaskId: string; runId: string; taskId: string };
    expect(body.taskId).toBe(refused.taskId);
    expect(body.runId).toBe(`dr-${body.freshTaskId}`);
    const successor = h.t.designs.filter((d) => d.requestId === requestId).at(-1)!;
    expect(successor).toMatchObject({ taskId: body.freshTaskId, runId: body.runId });
    expect(successor.refused).toBeUndefined();
    expect((await created(body.freshTaskId)).studioOptions).toMatchObject({ freshFrom: { parentTaskId, kind: 'redo', directive: LIVE_REDO } });
    expect((await studioAdmits(body.freshTaskId)).created).toBe(true);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'designing', current_task_id: body.freshTaskId });
    expect(await taskRow(refused.taskId)).toMatchObject({ state: 'cancelled' });
    expect(await bindings(parentTaskId)).toEqual(parentBinding);
    expect(await taskRow(parentTaskId)).toMatchObject({ state: 'complete' });
    // A second press is the same retry; the requester is told nothing by it.
    const again = await retry();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, freshTaskId: body.freshTaskId });
    expect(p.said.length).toBe(saidBefore);
    // The fresh design's draft reaches the office as any draft does.
    await p.draftReady(0);
    expect(await requestRow(requestId)).toMatchObject({ stage: 'in_review', current_task_id: body.freshTaskId });
  });
});
