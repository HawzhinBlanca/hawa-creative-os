import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, afterAll } from 'vitest';
import { createDb } from '@hawa/db';
import { TelegramBridgeDaemon, computeActionSignature } from '@hawa/integrations';
import { createApp } from '../src/app.js';

// Revisions, decisions, receipts and the outbox are only held in Postgres (architecture programme
// 1.3, groups G3 and G5), so these apps run on this file's own test database.
const testDb = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => testDb.destroy());

/**
 * Chat actions never approve or modify a design (ADR-022): the Telegram webhook refuses approve,
 * publish, revise and reject up front. The check read only `message.text`, while the command
 * dispatcher also reads channel posts and bare-text bodies, and matches any text that merely starts
 * with the command. Through those gaps `/approve <unknown id>` reached a handler that created the task
 * on the spot (KAAE, AWAITING_APPROVAL, an invented title) and approved it; `/revise` did the same.
 * Those handlers now also refuse an unknown task instead of making one up.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';

function setup() {
  const bridge = new TelegramBridgeDaemon({});
  const sent: string[] = [];
  const answers: string[] = [];
  vi.spyOn(bridge, 'dispatchOutboundMessage').mockImplementation(async (_chat: any, message: any) => {
    sent.push(typeof message === 'string' ? message : message?.text || '');
    return true as any;
  });
  vi.spyOn(bridge, 'answerCallbackQuery').mockImplementation(async (_id: any, text: any) => {
    answers.push(String(text));
    return true as any;
  });
  const app = createApp({ db: testDb, testAuth: { principal: { role: 'operator' }, roleHeader: true },  telegramBridge: bridge });

  const webhook = (body: Record<string, unknown>) =>
    app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'expected_office_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), ...body }),
    });
  const taskExists = async (taskId: string) => (await app.request(`/tasks/${taskId}`)).status !== 404;

  async function taskAwaitingApproval() {
    const created = await (
      await app.request('/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'KAAE notice', clientId: KAAE }) })
    ).json();
    const taskId: string = created.id || created.task?.id;
    await app.request(`/tasks/${taskId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: { id: 'd', pages: [{ id: 'p1', name: 'main', width: 1080, height: 1080, unit: 'px' }], nodes: [{ id: 'h', type: 'text', text: 'KAAE' }] } }),
    });
    return taskId;
  }
  const status = async (taskId: string) => (await (await app.request(`/tasks/${taskId}`)).json()).status;

  return { sent, answers, webhook, taskExists, taskAwaitingApproval, status };
}

// Every shape in which the dispatcher finds command text.
const shapes: Array<[string, (text: string) => Record<string, unknown>]> = [
  ['message', (text) => ({ message: { text, chat: { id: 777 }, from: { id: 777 } } })],
  ['channel post', (text) => ({ channel_post: { text, chat: { id: 777 } } })],
  ['bare text body', (text) => ({ text })],
  ['message caption', (text) => ({ message: { caption: text, chat: { id: 777 }, from: { id: 777 } } })],
];
const commands = ['/approve', '/publish', '/revise', '/reject', '/approve_now', '/Approve'];

describe('Telegram never approves, revises or makes up a task', () => {
  for (const [shape, body] of shapes) {
    it(`refuses approve/publish/revise/reject for an unknown task in a ${shape}, and creates nothing`, async () => {
      const { sent, webhook, taskExists } = setup();
      for (const command of commands) {
        const unknownId = randomUUID();
        const res = await webhook(body(`${command} ${unknownId} notes`));
        expect(res.status, `${shape} ${command}`).toBe(422);
        expect((await res.json()).title).toBe('Desk review required');
        expect(await taskExists(unknownId), `${shape} ${command}`).toBe(false);
      }
      // The sender is told where approval happens (a typed command used to get no reply at all),
      // and nothing else: no approval, no revision, no task.
      expect(sent.filter((t) => !/approved in Hawa Desk, not in chat/.test(t))).toEqual([]);
    });
  }

  it('refuses a signed Approve or Revise button, for an unknown or a real task', async () => {
    const { answers, webhook, taskExists, taskAwaitingApproval, status } = setup();
    const realTask = await taskAwaitingApproval();
    for (const [action, name] of [['app', 'approve'], ['rev', 'revision']] as const) {
      for (const taskId of [randomUUID(), realTask]) {
        const data = `${action}:${taskId}:${computeActionSignature(taskId, name)}`;
        const res = await webhook({ callback_query: { id: `cb-${randomUUID()}`, data, from: { id: 777 }, message: { chat: { id: 777 } } } });
        expect(res.status).toBe(422);
      }
    }
    expect(answers).toEqual(Array(4).fill('Desk review required: Approve in Hawa Desk'));
    expect(await status(realTask)).toBe('AWAITING_APPROVAL');
  });

  it('a real task named in a channel post stays awaiting approval', async () => {
    const { webhook, taskAwaitingApproval, status } = setup();
    const taskId = await taskAwaitingApproval();
    const res = await webhook({ channel_post: { text: `/approve ${taskId}`, chat: { id: 777 } } });
    expect(res.status).toBe(422);
    expect(await status(taskId)).toBe('AWAITING_APPROVAL');
  });

  it('other commands still reach the bot', async () => {
    const { sent, webhook } = setup();
    const res = await webhook({ message: { text: '/help', chat: { id: 777 }, from: { id: 777 } } });
    expect(res.status).toBe(200);
    expect(sent.length).toBe(1);
  });
});
