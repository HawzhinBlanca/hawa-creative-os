import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reconsiderNewBrief } from '../src/services/brief-or-change.js';
import { planTurn, readIntentByRules, type ChatRequestView, type IntentReading, type PendingAsk, type TurnInput,
  type TurnIntent, type TurnPlan } from '../src/services/requester-turn.js';

/**
 * NLU evaluation (2026-10-02). A measurement, not a gate: every labelled requester utterance in
 * fixtures/nlu-eval/utterances.json is read the way Core's intake reads it with the model reading off
 * (`readIntentByRules`, then `planTurn` against the case's context, then ADR-250's `reconsiderNewBrief`;
 * a chat with nothing on the way is planned with no requests, as intake does),
 * and the outcome is scored against what a human office member would take the words to mean. The report
 * goes to plans/nlu-eval-2026-10-02/BASELINE.json. Only the fixture's shape is asserted; the accuracy is
 * whatever the rules achieve (see plans/nlu-eval-2026-10-02/README.md).
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE = resolve(import.meta.dirname, 'fixtures/nlu-eval/utterances.json');
const REPORT = resolve(ROOT, 'plans/nlu-eval-2026-10-02/BASELINE.json');

const INTENTS: TurnIntent[] = ['new_brief', 'change', 'cancel', 'hold', 'approval', 'acknowledgement', 'status', 'deadline',
  'delivery_request', 'conversation', 'unclear'];
const CONTEXTS = ['none', 'designing', 'in_review', 'awaiting_answer', 'delivered', 'just_cancelled', 'two_open'] as const;
const LANGS = ['en', 'ckb', 'mixed'] as const;
const SOURCES = ['live-bug', 'stress-fixture', 'synthetic'] as const;
const TARGETS = ['A', 'B', 'both', 'ask'];
type Context = typeof CONTEXTS[number];

interface Case {
  id: string;
  text: string;
  lang: typeof LANGS[number];
  context: Context;
  pendingAsk?: 'change_or_new';
  expected: {
    intent: TurnIntent;
    alsoAccept?: TurnIntent[];
    target?: string | string[];
    refusalOnly?: boolean;
    question?: boolean;
    redo?: boolean;
    undo?: boolean;
    every?: 'both' | 'all';
    bareCancel?: boolean;
    multi?: boolean;
  };
  source: typeof SOURCES[number];
  /** Added after the 2026-10-02 baseline and written before the rule fix it tests: held out from tuning. */
  heldOut?: boolean;
  note: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] };
const cases = fixture.cases;

// ---------------------------------------------------------------------------------------------
// The chat each case is said in
// ---------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-02T09:00:00Z');
const QA = 'KAAE: Quality Assurance Workshop';
const TAD = 'KAAE: Teacher Appreciation Day';
const view = (requestId: string, stage: ChatRequestView['stage'], title: string, minutesAgo: number,
  extra: Partial<ChatRequestView> = {}): ChatRequestView => ({
  requestId, stage, rev: 2, currentTaskId: `${requestId}-task`, clientId: 'kaae', title,
  activeAt: new Date(NOW - minutesAgo * 60_000).toISOString(), createdAt: new Date(NOW - (minutesAgo + 1) * 60_000).toISOString(),
  question: null, requesterId: '1', ...extra,
});
const REQUESTS: Record<Context, ChatRequestView[]> = {
  none: [],
  designing: [view('A', 'designing', QA, 5)],
  in_review: [view('A', 'in_review', QA, 5)],
  awaiting_answer: [view('A', 'awaiting_answer', QA, 5, { rev: 3 })],
  delivered: [view('A', 'delivered', QA, 60, { sentToChat: true })],
  // The withdrawn design is closed, so the chat no longer lists it; another one is being made.
  just_cancelled: [view('B', 'designing', TAD, 10)],
  two_open: [view('A', 'in_review', QA, 6), view('B', 'designing', TAD, 3)],
};
const ASKS: Record<NonNullable<Case['pendingAsk']>, PendingAsk> = {
  change_or_new: { updateId: 7, intent: 'unclear', words: 'Quality Assurance Workshop, 22 October',
    options: [{ requestId: 'A', title: QA }], allowNew: true },
};

// ---------------------------------------------------------------------------------------------
// From a reading and a plan to the intent it acted on
// ---------------------------------------------------------------------------------------------

/** The rules' reading alone: a cancel that names nothing is asked about (ADR-251), so it scores as unclear. */
function readingIntent(reading: IntentReading): TurnIntent {
  return reading.intent === 'cancel' && reading.bareCancel ? 'unclear' : reading.intent;
}

/** What the plan does, in the planner's vocabulary: an open is a brief, a note of a change is a change, a question is unclear. */
function planIntent(plan: TurnPlan, reading: IntentReading): TurnIntent {
  switch (plan.kind) {
    case 'open': return 'new_brief';
    case 'revise': case 'redo': return 'change';
    case 'note': return plan.note;
    case 'cancel-all': return 'cancel';
    case 'tell': return plan.note === 'delivery' ? 'delivery_request' : plan.note;
    case 'reply':
      if (plan.what === 'nothing-to-change') return 'change';
      if (plan.what === 'nothing-to-cancel') return 'cancel';
      if (plan.what === 'thanks') return reading.intent === 'approval' ? 'approval' : 'acknowledgement';
      return ['cancel', 'hold', 'deadline', 'approval'].includes(reading.intent) ? reading.intent : 'status';
    case 'forward': return plan.question ? 'conversation' : reading.intent;
    case 'ask':
      // "Change or new?", "redo or new?", and "Do you want me to cancel …?" for words that named nothing are
      // the bot asking what was meant; "which design?" about a certain intent keeps that intent.
      if (plan.allowNew || plan.intent === 'unclear' || plan.redo === 'or-new' || (plan.intent === 'cancel' && reading.bareCancel)) return 'unclear';
      return plan.intent;
    case 'passive': case 'conversation': return 'conversation';
  }
}

/** The design the plan acts on: A, B, both, ask (which design?), or null (none). */
function planTarget(plan: TurnPlan): string | null {
  switch (plan.kind) {
    case 'revise': case 'redo': case 'note': case 'tell': return plan.requestId;
    case 'cancel-all': return plan.requestIds.length >= 2 ? 'both' : plan.requestIds[0] ?? null;
    case 'ask': return plan.options.length >= 2 ? 'ask' : plan.options[0]?.requestId ?? null;
    // "It was already delivered" names the design it found too late for a cancel or a change.
    case 'reply': return plan.what.startsWith('nothing-to-') && plan.requestIds.length === 1 ? plan.requestIds[0] : null;
    default: return null;
  }
}

interface Outcome {
  id: string; text: string; lang: Case['lang']; context: Context; source: Case['source']; heldOut: boolean; pendingAsk: string | null;
  expected: TurnIntent; accepted: TurnIntent[]; got: TurnIntent; correct: boolean;
  rulesIntent: TurnIntent; rulesCorrect: boolean; reason: string; plan: string;
  expectedTarget: string[] | null; gotTarget: string | null; targetCorrect: boolean | null; note: string;
}

function run(c: Case): Outcome {
  let reading = readIntentByRules(c.text);
  const accepted = [c.expected.intent, ...(c.expected.alsoAccept ?? [])];
  const rulesIntent = readingIntent(reading);
  const input: TurnInput = { text: c.text, reading, requests: REQUESTS[c.context], bound: [], unboundReply: false, senderId: '1',
    officeIds: [], group: false, addressed: true, pendingAsk: c.pendingAsk ? ASKS[c.pendingAsk] : null, now: NOW };
  let plan = planTurn(input);
  const edit = reconsiderNewBrief(input, plan);
  if (edit) ({ reading, plan } = edit);
  const got = planIntent(plan, reading);
  const correct = accepted.includes(got);
  const expectedTarget = c.expected.target === undefined ? null : ([] as string[]).concat(c.expected.target);
  const gotTarget = planTarget(plan);
  return {
    id: c.id, text: c.text, lang: c.lang, context: c.context, source: c.source, heldOut: c.heldOut === true, pendingAsk: c.pendingAsk ?? null,
    expected: c.expected.intent, accepted, got, correct, rulesIntent, rulesCorrect: accepted.includes(rulesIntent),
    reason: reading.reason, plan: planSummary(plan),
    expectedTarget, gotTarget, targetCorrect: expectedTarget ? correct && gotTarget !== null && expectedTarget.includes(gotTarget) : null,
    note: c.note,
  };
}

function planSummary(plan: TurnPlan): string {
  const target = planTarget(plan);
  const what = plan.kind === 'note' || plan.kind === 'tell' ? `:${plan.note}` : plan.kind === 'reply' ? `:${plan.what}`
    : plan.kind === 'ask' ? `:${plan.intent}${plan.allowNew ? '+new' : ''}` : plan.kind === 'forward' && plan.question ? ':question' : '';
  return `${plan.kind}${what}${target ? ` -> ${target}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
function accuracy(rows: Outcome[], key: 'correct' | 'rulesCorrect' = 'correct') {
  const right = rows.filter((r) => r[key]).length;
  return { cases: rows.length, correct: right, accuracy: pct(right, rows.length) };
}
function groupBy<K extends string>(rows: Outcome[], key: (r: Outcome) => K) {
  const out: Partial<Record<K, ReturnType<typeof accuracy>>> = {};
  for (const k of [...new Set(rows.map(key))].sort()) out[k] = accuracy(rows.filter((r) => key(r) === k));
  return out;
}

function report(rows: Outcome[]) {
  // A case scored right counts as its expected intent (an accepted alternative is not a confusion).
  const scored = rows.map((r) => ({ ...r, as: r.correct ? r.expected : r.got }));
  const perIntent: Record<string, { support: number; predicted: number; truePositives: number; precision: number | null; recall: number | null; f1: number | null }> = {};
  for (const intent of INTENTS) {
    const support = scored.filter((r) => r.expected === intent).length;
    const predicted = scored.filter((r) => r.as === intent).length;
    const tp = scored.filter((r) => r.expected === intent && r.as === intent).length;
    const precision = predicted ? tp / predicted : null;
    const recall = support ? tp / support : null;
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
    perIntent[intent] = { support, predicted, truePositives: tp, precision: round(precision), recall: round(recall), f1: round(f1) };
  }
  const confusion: Record<string, Record<string, number>> = {};
  for (const e of INTENTS) {
    confusion[e] = {};
    for (const g of INTENTS) {
      const n = scored.filter((r) => r.expected === e && r.as === g).length;
      if (n) confusion[e][g] = n;
    }
  }
  const targeted = rows.filter((r) => r.targetCorrect !== null);
  const failureClasses: Record<string, number> = {};
  for (const r of rows.filter((x) => !x.correct)) failureClasses[`${r.expected} -> ${r.got}`] = (failureClasses[`${r.expected} -> ${r.got}`] ?? 0) + 1;
  return {
    title: 'Hawa requester NLU baseline: rules only (model reading off)',
    fixture: 'apps/core/test/fixtures/nlu-eval/utterances.json',
    pipeline: 'readIntentByRules -> planTurn (context) -> reconsiderNewBrief (ADR-250); no model call. Context "none" plans against an empty chat.',
    scoring: 'A case is right when the intent acted on is its expected intent or one of its alsoAccept intents. Plans map to intents: open=new_brief; revise/redo/note change=change; note/cancel-all=cancel; tell=approval/deadline/delivery_request; reply thanks=acknowledgement; reply status=status; forward question=conversation; ask with "or a new design", or a confirmation of a cancel that named nothing, =unclear; any other ask keeps its intent (it only asks which design).',
    overall: accuracy(rows),
    // The 302 cases of the 2026-10-02 baseline, and the cases added after it (each written before the fix it
    // tests, so they are held out from tuning). Compare `original` with the baseline README.
    perSet: {
      original: { ...accuracy(rows.filter((r) => !r.heldOut)), perSource: groupBy(rows.filter((r) => !r.heldOut), (r) => r.source),
        perLanguage: groupBy(rows.filter((r) => !r.heldOut), (r) => r.lang) },
      heldOut: accuracy(rows.filter((r) => r.heldOut)),
    },
    rulesReadingOnly: { ...accuracy(rows, 'rulesCorrect'), note: 'readIntentByRules alone, without context or planning' },
    perLanguage: groupBy(rows, (r) => r.lang),
    perContext: groupBy(rows, (r) => r.context),
    perSource: groupBy(rows, (r) => r.source),
    perIntent,
    target: { cases: targeted.length, correct: targeted.filter((r) => r.targetCorrect).length,
      accuracy: pct(targeted.filter((r) => r.targetCorrect).length, targeted.length),
      note: 'Cases with an expected design: right when the intent is right and the plan acts on (or asks about) that design.' },
    confusion: { rows: 'expected', columns: 'got', matrix: confusion },
    failureClasses: Object.fromEntries(Object.entries(failureClasses).sort((a, b) => b[1] - a[1])),
    // The errors that cost most: words opened as a new request (a second request, maybe a paid draft), a design
    // withdrawn, or approval words heard, when none of that was meant.
    costlyErrors: rows.filter((r) => !r.correct && ['new_brief', 'cancel', 'approval'].includes(r.got)).map((r) => ({ id: r.id, lang: r.lang,
      context: r.context, text: r.text, expected: r.accepted.join(' | '), got: r.got, plan: r.plan })),
    failures: rows.filter((r) => !r.correct).map((r) => ({ id: r.id, lang: r.lang, context: r.context, source: r.source,
      ...(r.heldOut ? { heldOut: true } : {}), text: r.text,
      expected: r.accepted.join(' | '), got: r.got, rules: r.rulesIntent, reason: r.reason, plan: r.plan, note: r.note })),
    targetMisses: targeted.filter((r) => r.correct && !r.targetCorrect).map((r) => ({ id: r.id, lang: r.lang, context: r.context, text: r.text,
      expected: r.expectedTarget, got: r.gotTarget, plan: r.plan })),
    // Every case's outcome, so a later reader (model-first, or changed rules) can be compared case by case.
    outcomes: rows.map((r) => ({ id: r.id, ok: r.correct, got: r.got, plan: r.plan })),
  };
}

describe('NLU evaluation set (measurement; accuracy is reported, not asserted)', () => {
  it('the fixture is well formed', () => {
    expect(cases.length).toBeGreaterThanOrEqual(180);
    const ids = cases.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const c of cases) {
      const where = `${c.id}`;
      expect(typeof c.text === 'string' && c.text.trim().length > 0, where).toBe(true);
      expect(LANGS, where).toContain(c.lang);
      expect(CONTEXTS, where).toContain(c.context);
      expect(SOURCES, where).toContain(c.source);
      expect(INTENTS, where).toContain(c.expected.intent);
      for (const also of c.expected.alsoAccept ?? []) {
        expect(INTENTS, where).toContain(also);
        expect(also, where).not.toBe(c.expected.intent);
      }
      for (const t of c.expected.target === undefined ? [] : ([] as string[]).concat(c.expected.target)) {
        expect(TARGETS, where).toContain(t);
        if (t !== 'ask' && t !== 'both') expect(REQUESTS[c.context].map((r) => r.requestId), where).toContain(t);
      }
      if (c.pendingAsk) expect(Object.keys(ASKS), where).toContain(c.pendingAsk);
      if (c.heldOut !== undefined) expect(c.heldOut === true && c.source === 'synthetic', where).toBe(true);
      expect(typeof c.note === 'string' && c.note.length > 0, where).toBe(true);
    }
    // Every intent of the planner's vocabulary is represented, in both languages for the main classes.
    for (const intent of INTENTS) expect(cases.some((c) => c.expected.intent === intent), intent).toBe(true);
    for (const intent of ['new_brief', 'change', 'cancel', 'approval', 'acknowledgement', 'status', 'deadline'] as const) {
      expect(cases.some((c) => c.expected.intent === intent && c.lang !== 'en'), `Sorani ${intent}`).toBe(true);
    }
  });

  it('scores the rules and writes the baseline report', () => {
    const rows = cases.map(run);
    const out = report(rows);
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify(out, null, 2)}\n`);
    expect(out.overall.cases).toBe(cases.length);
    // The headline, for whoever runs it.
    console.log(`[nlu-eval] overall ${out.overall.correct}/${out.overall.cases} (${out.overall.accuracy}%); ` +
      `original ${out.perSet.original.correct}/${out.perSet.original.cases}; held out ${out.perSet.heldOut.correct}/${out.perSet.heldOut.cases}; ` +
      Object.entries(out.perLanguage).map(([k, v]) => `${k} ${v?.accuracy}%`).join(', ') + `; report ${REPORT}`);
  });
});
