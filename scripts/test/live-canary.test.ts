import { describe, expect, it } from 'vitest';
import {
  CANARY_UPDATE_BASE, canaryConfigFromEnv, copyExtractionProblems, internalCodeProblems, leakProblems, nightPlan, nightUpdateBase, runCanary,
  summaryText, type BotMessage, type CanaryConfig, type CanaryWorld, type RequestView,
} from '../live_canary_lib.js';
import { journalStrings, senderJournal } from '../live_canary.js';

/**
 * ADR-240: the nightly canary's judgement, over a scripted bot. apps/core/test/live-canary.test.ts plays
 * the same conversation through the real path on the test database; this file covers what that one
 * cannot make happen: a sink that is off, a leak, an internal code in a reply, a request that will not
 * close, an earlier night's leftover, and reading Restate's journal.
 */
const CHAT = String(2 ** 52 + 77);
const CLIENT = '5e1f0000-0000-4000-8000-0000000000aa';
const config: CanaryConfig = { chatId: CHAT, clientId: CLIENT, clientName: 'CANARY', maxUsd: 0.5, replyTimeoutMs: 20_000, quietMs: 2000, draftTimeoutMs: 60_000 };
const NOW = Date.UTC(2026, 9, 2, 0, 30);

interface Faults { sink?: BotMessage['outcome']; leak?: boolean; code?: boolean; stuckCancel?: boolean; leftover?: RequestView; paid?: boolean; spend?: number }

/** A bot that answers the canary's lines roughly as production does (the real one is in apps/core's test). */
function scriptedBot(faults: Faults = {}) {
  let now = NOW, seq = 0, pendingBrief: string | null = null;
  const messages: BotMessage[] = [];
  const requests = new Map<string, RequestView & { event: string; brief: string; designingUntil?: number }>();
  if (faults.leftover) requests.set(faults.leftover.requestId, { ...faults.leftover, event: faults.leftover.title ?? '', brief: '' });
  const say = (text: string, extra: Partial<BotMessage> = {}) => messages.push({ invocationId: `inv_${++seq}`, chatId: CHAT, createdAtMs: now, key: `k${seq}`,
    kind: 'text', text: faults.code && !extra.canaryFor ? `${text} SENDER_DAILY_CAP` : text, outcome: faults.sink ?? 'canary_sink', ...extra });
  const open = (brief: string) => {
    const event = /our ([A-Z][a-z]+ [A-Za-z ]+?)\?/.exec(brief)![1];
    const id = `00000000-0000-4000-8000-${String(requests.size + 1).padStart(12, '0')}`;
    const paid = faults.paid && ![...requests.values()].some((r) => r.stage !== 'cancelled' || r.requestId !== faults.leftover?.requestId);
    requests.set(id, { requestId: id, chatId: CHAT, stage: paid ? 'designing' : 'manual', rev: 1, taskId: `00000000-0000-4000-9000-${String(requests.size + 1).padStart(12, '0')}`,
      title: event, event, brief, ...(paid ? { designingUntil: now + 30_000 } : {}) });
    say(paid ? `Got it. I'm making a first draft of <b>${event}</b>.` : `Got it. A designer will make <b>${event}</b> and send it to you here.`);
    if (faults.leak) messages.push({ invocationId: `inv_${++seq}`, chatId: '9000001', createdAtMs: now, key: `${id}:1:office-alert`, kind: 'text',
      text: `New request "${event}"`, outcome: 'sent' });
  };
  const latest = () => [...requests.values()].filter((r) => r.stage !== 'cancelled').at(-1);
  const world: CanaryWorld = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      for (const r of requests.values()) if (r.designingUntil && now >= r.designingUntil && r.stage === 'designing') { r.stage = 'in_review'; say(`Your draft of <b>${r.event}</b> is with the office.`); }
    },
    health: async () => null,
    send: async (_u, _m, text) => {
      now += 500;
      if (text === 'hi') return void say('👋 Hi! What would you like designed?');
      if (/^Could you design a CANARY/.test(text)) return open(text);
      if (/^Could you design a poster/.test(text)) { pendingBrief = text; return void say("Who is this design for? Tell me the organisation's name."); }
      if (/^it's for CANARY/.test(text) && pendingBrief) { open(pendingBrief); pendingBrief = null; return; }
      const cancel = /cancel (?:the )?(.+?)(?: poster| flyer)?,/.exec(text);
      if (cancel) {
        const r = [...requests.values()].find((x) => x.stage !== 'cancelled' && cancel[1].startsWith(x.event));
        if (r && !faults.stuckCancel) { r.stage = 'cancelled'; say(`Cancelled <b>${r.event}</b>. Nothing more will be made for it.`);
          say(`Canary cancelled "${r.event}".`, { canaryFor: '9000001' }); }
        else say("There's nothing open for me to cancel right now.");
        return;
      }
      const r = latest();
      if (/^also/.test(text)) return void say(`Got it. I've kept that with <b>${r?.event}</b> for the office.`);
      if (/status/.test(text)) return void say(`A designer at the office is working on <b>${r?.event}</b>.`);
      if (/^thanks/.test(text)) return void say('🙏 Thank you.');
      if (/videos/.test(text)) return void say("I can't answer that myself, so I've passed your question to the office; they'll reply here.");
      say('Sorry?');
    },
    inboxDone: async () => true,
    botMessages: async (since) => messages.filter((m) => m.createdAtMs >= since),
    canaryRequests: async () => [...requests.values()].map(({ event: _e, brief: _b, designingUntil: _d, ...r }) => r),
    openDraft: async (requestId) => {
      const r = requests.get(requestId);
      if (!r) return null;
      const date = /on (\d+ [A-Z][a-z]+ \d{4})/.exec(r.brief)?.[1] ?? '';
      return { clientId: CLIENT, title: r.event, rawText: r.brief, exactCopy: [{ role: 'headline', text: r.event }, { role: 'body', text: `${date} · 10:00 AM` }] };
    },
    designSpend: async () => faults.spend ?? 0.08,
  };
  return { world, messages, requests };
}

describe('the canary\'s conversation, judged (ADR-240)', () => {
  it('passes a night where every answer is right, and withdraws every request it opened', async () => {
    const { world, requests } = scriptedBot();
    const result = await runCanary(world, config);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result).toMatchObject({ status: 'passed', mode: 'stub', spentUsd: null });
    expect([...requests.values()].map((r) => r.stage)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(summaryText(result)).toMatch(/^Hawa nightly canary PASSED \(stub night\)/);
  });

  it('a paid night waits for the draft, reports the spend, and fails above the cap', async () => {
    const ok = await runCanary(scriptedBot({ paid: true }).world, config);
    expect(ok).toMatchObject({ status: 'passed', mode: 'paid', spentUsd: 0.08 });
    const dear = await runCanary(scriptedBot({ paid: true, spend: 0.61 }).world, config);
    expect(dear.status).toBe('failed');
    expect(dear.checks.find((c) => !c.ok)).toMatchObject({ step: 'draft', name: 'the round spent at most $0.50' });
  });

  it('stops after "hi" when replies are sent instead of recorded, and says why', async () => {
    const { world, requests } = scriptedBot({ sink: 'sent' });
    const result = await runCanary(world, config);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/replies to the canary chat are recorded, never sent.*HAWA_CANARY_CHAT_ID/);
    expect(requests.size).toBe(0);
  });

  it('fails a night where an office alert about a canary request reached a real chat', async () => {
    const result = await runCanary(scriptedBot({ leak: true }).world, config);
    expect(result.status).toBe('failed');
    expect(result.checks.find((c) => c.name === 'nothing about the canary reached anyone')).toMatchObject({ ok: false,
      detail: expect.stringMatching(/went to chat 9000001 \(sent/) });
  });

  it('fails a night where a requester was shown an internal code', async () => {
    const result = await runCanary(scriptedBot({ code: true }).world, config);
    expect(result.checks.find((c) => c.name.startsWith('no requester message carries'))).toMatchObject({ ok: false,
      detail: expect.stringContaining('SENDER_DAILY_CAP') });
  });

  it('cleanup: a request that will not close fails the night by name', async () => {
    const result = await runCanary(scriptedBot({ stuckCancel: true }).world, config);
    expect(result.status).toBe('failed');
    const closed = result.checks.find((c) => c.name === 'every canary request ends closed');
    expect(closed).toMatchObject({ ok: false });
    expect(closed!.detail.split(', ')).toHaveLength(3);
    expect(result.requests.every((r) => r.stage === 'manual' && r.openedThisRun)).toBe(true);
  });

  it('cleanup: an earlier night\'s open request is withdrawn first', async () => {
    const leftover: RequestView = { requestId: '00000000-0000-4000-8000-0000000000ff', chatId: CHAT, stage: 'manual', rev: 1,
      taskId: '00000000-0000-4000-9000-0000000000ff', title: 'Old Reading Workshop' };
    const { world, requests } = scriptedBot({ leftover });
    const result = await runCanary(world, config);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(requests.get(leftover.requestId)!.stage).toBe('cancelled');
    expect(result.requests.find((r) => r.requestId === leftover.requestId)).toMatchObject({ openedThisRun: false, stage: 'cancelled' });
  });
});

describe('the canary\'s pieces', () => {
  it('reads its configuration, and refuses a chat that is not in the reserved range', () => {
    expect(canaryConfigFromEnv({ HAWA_CANARY_CHAT_ID: CHAT, HAWA_CANARY_CLIENT_ID: CLIENT, HAWA_CANARY_CLIENT_NAME: 'CANARY' }).config)
      .toMatchObject({ chatId: CHAT, clientId: CLIENT, clientName: 'CANARY', maxUsd: 0.5 });
    const bad = canaryConfigFromEnv({ HAWA_CANARY_CHAT_ID: '7191500129', HAWA_CANARY_CLIENT_ID: 'x', HAWA_CANARY_MAX_USD: '-1' });
    expect(bad.config).toBeNull();
    expect(bad.problems).toHaveLength(4);
  });

  it('numbers each night\'s updates apart from real ones, the owner\'s manual tests and the copy reader\'s range', () => {
    const base = nightUpdateBase(NOW);
    expect(base).toBeGreaterThan(8_000_000_000 + 1_000_000);
    expect(base + 999).toBeLessThan(2 ** 51);
    expect(nightUpdateBase(NOW + 86_400_000) - base).toBe(1000);
    expect(base % 1000).toBe(0);
    expect(base - CANARY_UPDATE_BASE).toBeLessThan(2 ** 31);
  });

  it('plans briefs whose third names no organisation, with a word of the night in every event', () => {
    const plan = nightPlan(NOW, 'CANARY');
    expect(plan.briefA).toContain('CANARY');
    expect(plan.briefB).toContain('CANARY');
    expect(plan.briefC).not.toContain('CANARY');
    for (const e of [plan.eventA, plan.eventB, plan.eventC]) expect(e.startsWith(plan.nonce)).toBe(true);
    expect(nightPlan(NOW + 86_400_000, 'CANARY').nonce).not.toBe(plan.nonce);
  });

  it('finds ids, codes and chat ids in what a requester reads, and lets dates and times through', () => {
    expect(internalCodeProblems('Got it. A designer will make <b>Amber Fair</b> on 16 November 2026 at 10:00 AM.', CHAT)).toEqual([]);
    expect(internalCodeProblems('Task 3a4c6ac4-1111-4222-8333-444455556666 failed', CHAT)).toEqual([expect.stringContaining('a UUID')]);
    expect(internalCodeProblems('DESIGN_REJECTED (NATIVE_REVISION_HANDOFF_REQUIRED)', CHAT)).toEqual([expect.stringContaining('DESIGN_REJECTED')]);
    expect(internalCodeProblems(`The requester in chat ${CHAT}`, CHAT)).toEqual(['the chat id']);
    expect(internalCodeProblems('The requester in chat 7191500129', CHAT)).toEqual([expect.stringContaining('7191500129')]);
  });

  it('judges the copy taken from a sentence (ADR-232)', () => {
    const brief = "Could you design a CANARY poster for our Amber Reading Workshop? It's on 16 November 2026 at 10:00 AM in the Main Hall, Erbil.";
    const expected = { headline: 'Amber Reading Workshop', date: '16 November 2026', brief };
    expect(copyExtractionProblems({ clientId: CLIENT, title: 'Amber Reading Workshop', rawText: brief,
      exactCopy: [{ role: 'headline', text: 'Amber Reading Workshop' }, { role: 'body', text: '16 November 2026 · 10:00 AM' }] }, expected)).toEqual([]);
    expect(copyExtractionProblems({ clientId: CLIENT, title: 'Could you design a CANARY poster for our…', rawText: brief,
      exactCopy: [{ role: 'body', text: brief }] }, expected)).toHaveLength(3);
  });

  it('a message about a canary request to another chat is a leak unless the sink recorded it', () => {
    const m = (chatId: string, outcome: BotMessage['outcome'], text = 'Amber Reading Workshop is ready'): BotMessage =>
      ({ invocationId: 'inv_1', chatId, createdAtMs: NOW, key: 'k', kind: 'text', text, outcome });
    expect(leakProblems([m('9000001', 'canary_sink'), m('9000002', 'sent', 'another request'), m(CHAT, 'canary_sink')], CHAT, ['Amber Reading Workshop'], [])).toEqual([]);
    expect(leakProblems([m('9000001', 'sent')], CHAT, ['Amber Reading Workshop'], [])).toHaveLength(1);
    expect(leakProblems([m(CHAT, 'refused')], CHAT, [], [])).toHaveLength(1);
  });

  it('decodes a TelegramSender journal: its message, and the send step\'s answer', () => {
    const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
    const input = { v: 1, key: 'r:1:ack', chatId: CHAT, kind: 'text', text: 'Got it.' };
    const entries = [
      { index: 0, entry_json: JSON.stringify({ Command: { Input: { headers: [], payload: bytes(input) } } }) },
      { index: 1, entry_json: { Command: { Run: { name: 'send' } } } },
      { index: 2, entry_json: { Notification: { Completion: { Run: { result: { Success: Buffer.from(JSON.stringify({ outcome: 'canary_sink', messageId: '1125899906842625' })).toString('base64') } } } } } },
    ];
    expect(senderJournal(entries)).toEqual({ input, outcome: 'canary_sink' });
    expect(senderJournal(entries.slice(0, 2))).toEqual({ input, outcome: null });
    expect(journalStrings({ a: [104, 105] })).toEqual(['hi']);
  });
});
