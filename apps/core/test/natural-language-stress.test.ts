import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { ConversationHarness, type Person } from './fixtures/conversation-harness.js';
import { Play, frictionIssues, type Script } from './fixtures/conversation-script.js';
import { BRIEF_SCRIPTS } from './fixtures/nl-scripts/briefs.js';
import { CHANGE_SCRIPTS } from './fixtures/nl-scripts/changes.js';
import { CONVERSATION_SCRIPTS } from './fixtures/nl-scripts/conversation.js';
import { MEDIA_SCRIPTS } from './fixtures/nl-scripts/media.js';
import { OFFICE_AND_GROUP_SCRIPTS } from './fixtures/nl-scripts/office-and-groups.js';
import { OFFICE_CHAT_SCRIPTS } from './fixtures/nl-scripts/office-chat.js';
import { REDO_SCRIPTS } from './fixtures/nl-scripts/redo.js';
import { TRUTHFUL_SCRIPTS } from './fixtures/nl-scripts/truthful.js';

/**
 * NATURAL-LANGUAGE STRESS SUITE (ADR-182). Owner rule: requesters use natural language only, and
 * friction is hunted always. About a hundred scripted conversations in English, Sorani and both, played
 * through the worker's ChatInbox, Core's real intake route, TelegramSender and RequestLifecycle
 * (fixtures/conversation-harness.ts), each held to what a thoughtful office assistant would do.
 *
 * A script marked `open` names a defect still open: it asserts the natural outcome and is expected to
 * fail (`it.fails`) until the defect is fixed, when it must become a plain test.
 *
 * HAWA_NL_TRANSCRIPTS=<dir> writes every conversation as it was said, for reading.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const WORKER = ['conversation', 'worker', 'fixture'].join('_');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); await owner.destroy(); });

let officeSeed = 93_400_000 + Math.floor(Math.random() * 100_000) * 10;
const SCRIPTS: Script[] = [...BRIEF_SCRIPTS, ...CHANGE_SCRIPTS, ...CONVERSATION_SCRIPTS, ...MEDIA_SCRIPTS, ...OFFICE_AND_GROUP_SCRIPTS,
  ...OFFICE_CHAT_SCRIPTS, ...REDO_SCRIPTS, ...TRUTHFUL_SCRIPTS];

function transcript(script: Script, p: Play): string {
  const h = p.h;
  const names = new Map<string, string>([[p.chatId, 'chat'], ...p.office.map((m) => [String(m.id), m.name] as [string, string])]);
  const lines = [`## ${script.id} ${script.title}`, `Natural: ${script.natural}`, ''];
  const events = [
    ...h.t.inbound.map((i) => ({ at: i.at, seq: i.updateId, line: `  [${(i.at / 1000).toFixed(0)}s] ${i.from.name} (${names.get(i.chatId) ?? i.chatId}, ${i.kind}, msg ${i.messageId}): ${i.text.replace(/\n/g, ' ⏎ ')}` })),
    ...h.t.sent.map((s) => ({ at: s.at, seq: 1e12 + s.seq, line: `  [${(s.at / 1000).toFixed(0)}s]   → bot to ${names.get(s.chatId) ?? s.chatId} (msg ${s.messageId}${s.kind === 'text' ? '' : ` ${s.kind}`}, ${s.key.replace(/[0-9a-f-]{36}/g, '<id>')}): ${s.text.replace(/\n/g, ' ⏎ ')}` })),
  ].sort((a, b) => a.at - b.at || a.seq - b.seq);
  lines.push(...events.map((e) => e.line));
  lines.push('', `  opened ${p.opened.length}: ${p.opened.map((o) => JSON.stringify(String(o.draft.rawText).slice(0, 120))).join(' | ')}`,
    `  revisions ${p.revisions.length}, kept for office ${p.kept.length}, designs started ${h.t.designs.length}`, '');
  return lines.join('\n');
}

/** The rules every conversation keeps, whatever its script. */
function generalRules(p: Play): string[] {
  const problems: string[] = [];
  if (p.h.t.paidCalls.length) problems.push(`paid calls: ${p.h.t.paidCalls.join(', ')}`);
  const officeChats = p.office.map((m) => String(m.id));
  for (const s of p.h.t.sent.filter((m) => !officeChats.includes(m.chatId))) {
    for (const issue of frictionIssues(s.text)) problems.push(`"${s.text.slice(0, 80)}": ${issue}`);
  }
  // Every message a person sends in a private chat is answered: by what its own handling sent (its
  // answer, its settle's, the request it opened), or by what was sent before the next message came.
  // A message followed by parts that need no answer of their own (a split, an album, a forward sent
  // with it) is answered by what was said for any of them.
  const inbound = p.h.t.inbound.filter((i) => i.chatId === p.chatId);
  for (const [k, i] of inbound.entries()) {
    if (p.quiet.has(i.updateId) || officeChats.includes(String(i.from.id)) || Number(i.chatId) < 0) continue;
    const next = inbound.slice(k + 1).find((j) => !p.quiet.has(j.updateId));
    const answers = p.h.t.sent.filter((s) => s.chatId === p.chatId && (s.cause === i.updateId ||
      (s.step >= i.step && (!next || s.step < next.step || (s.step === next.step && s.at < next.at)))));
    if (!answers.length) problems.push(`no answer to "${i.text.slice(0, 60) || i.kind}"`);
  }
  return problems;
}

describe('natural-language stress: requesters in English, Sorani and both (ADR-182)', () => {
  for (const script of SCRIPTS) {
    (script.open ? it.fails : it)(`${script.id} ${script.title}${script.open ? ` [open: ${script.open}]` : ''}`, async () => {
      officeSeed += 10;
      const office: Person[] = [{ id: officeSeed + 1, name: 'Office A' }, { id: officeSeed + 2, name: 'Office B' }];
      const h = new ConversationHarness({ db, owner, office, workerToken: WORKER });
      await h.emptyOfficeQueue();
      const p = new Play(h, office, script.kinds.includes('group') ? 'group' : 'private');
      let failure: unknown = null;
      try {
        await script.play(p);
        expect(generalRules(p)).toEqual([]);
      } catch (error) {
        failure = error;
      } finally {
        const dir = process.env.HAWA_NL_TRANSCRIPTS;
        if (dir) {
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, 'transcripts.md'), `${transcript(script, p)}${failure ? `  FAILED: ${String((failure as Error).message ?? failure).slice(0, 600)}\n` : ''}\n`);
        }
      }
      if (failure) throw failure;
    }, 120_000);
  }
});
