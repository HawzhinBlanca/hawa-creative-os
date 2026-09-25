import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import type { LifecycleEventType, OutboundMessage } from '@hawa/contracts';
import { plan, upgrade } from '@hawa/domain';
import { readDesignRunInput } from '../src/lifecycle/design-run.js';
import { eventOf, LIFECYCLE_EVENT_HANDLERS } from '../src/lifecycle/request-lifecycle.js';
import { HANDLERS_EVER } from '../src/lifecycle/shims.js';
import { handleSend, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';

/**
 * Payload evolution (PHASE2_DESIGN.md section 4 rule 1): a delayed or retried invocation may reach a
 * build newer than the one that sent it, so every handler input ever sent must still decode. The
 * fixtures in fixtures/lifecycle-payloads/ are the inputs as their senders built them, one file per
 * date; a new field means a new file, never an edit.
 */
const dir = join(import.meta.dirname, 'fixtures', 'lifecycle-payloads');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const fixtures = files.map((f) => ({ file: f, payloads: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown> }));
const states = ['v1-2026-09-25-opened.json', 'v1-2026-09-25-in-review.json', 'v1-2026-09-25-full.json', 'v1-2026-09-25-deferred.json']
  .map((f) => upgrade(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'packages', 'domain', 'test', 'fixtures', 'lifecycle-state', f), 'utf8'))));

const entries = () => fixtures.flatMap(({ file, payloads }) =>
  Object.entries(payloads).filter(([name]) => !name.startsWith('_')).map(([name, payload]) => {
    const [target] = name.split('#');
    const [service, handler] = target.split('/');
    return { file, name, service, handler, payload };
  }));

describe('every handler input ever sent still decodes', () => {
  it('there are fixtures', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(entries().length).toBeGreaterThan(10);
  });

  it('RequestLifecycle: each event is read and planned against every stored state shape', () => {
    for (const e of entries().filter((x) => x.service === 'RequestLifecycle')) {
      const ev = eventOf(e.handler as LifecycleEventType, e.payload);
      expect(ev.type, `${e.file} ${e.name}`).toBe(e.handler);
      for (const s of [undefined, ...states]) {
        expect(() => plan(s, ev, 1790233900000), `${e.file} ${e.name}`).not.toThrow();
      }
    }
  });

  it('DesignRun: each input is read', () => {
    for (const e of entries().filter((x) => x.service === 'DesignRun')) {
      expect(readDesignRunInput(e.payload).lifecycle.runId, `${e.file} ${e.name}`).toMatch(/^dr-/);
    }
  });

  it('TelegramSender: each message is taken (a courtesy one is sent through the bridge)', async () => {
    const answered: string[] = [];
    const deps: TelegramSenderDeps = {
      db: undefined,
      botToken: () => ['payload', 'test', 'bot'].join('_'),
      bridge: () => ({
        dispatchOutboundMessage: async () => ({ success: true, messageId: '1' }),
        dispatchOutboundDocument: async () => ({ success: true }),
        answerCallbackQuery: async (id: string) => { answered.push(id); return true; },
      }),
      readExportBytes: async () => null,
      officeChatId: () => null,
    };
    for (const e of entries().filter((x) => x.service === 'TelegramSender')) {
      const m = e.payload as OutboundMessage;
      expect(typeof m.key === 'string' && typeof m.chatId === 'string' && ['text', 'document', 'callback_answer'].includes(m.kind), `${e.file} ${e.name}`).toBe(true);
      // Critical messages need the send marks in Postgres; sent here as courtesy to exercise decoding only.
      const result = await handleSend({ run: (_n, action) => action(), sendTo: () => {} }, deps, { ...m, class: 'courtesy' });
      expect(result.outcome, `${e.file} ${e.name}`).toBe('sent');
    }
    expect(answered).toEqual(['cbq-1']);
  });

  it('every RequestLifecycle and DesignRun handler in the record has a fixture', () => {
    const covered = new Set(entries().map((e) => `${e.service}/${e.handler}`));
    const needed = HANDLERS_EVER.filter((h) => (h.service === 'RequestLifecycle' && h.handler !== 'get') || h.service === 'DesignRun').map((h) => `${h.service}/${h.handler}`);
    expect(needed.filter((n) => !covered.has(n))).toEqual([]);
    expect([...LIFECYCLE_EVENT_HANDLERS].sort()).toEqual(needed.filter((n) => n.startsWith('RequestLifecycle/')).map((n) => n.split('/')[1]).sort());
  });

  it('a payload that is not an event is refused, not guessed at', () => {
    expect(() => eventOf('remind', null)).toThrow(/not an event/);
    expect(() => eventOf('remind', { v: 1 })).toThrow(/event id/);
    expect(() => readDesignRunInput(null)).toThrow(restate.TerminalError);
  });
});
