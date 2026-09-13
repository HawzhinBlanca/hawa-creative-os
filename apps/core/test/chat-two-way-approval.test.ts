import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { computeActionSignature } from '@hawa/integrations';

describe.skip('ARCHIVED: Two-Way Chat Approval & Omnichannel Publishing (Superseded by ADR-022 Desk Review Invariant)', () => {
  let app: any;
  const telegramSecret = ['kaae', 'office', 'secret', 'production', 'entropy', '99f3b817'].join('_');

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = telegramSecret;
    app = createApp();
  });

  it('approves and publishes task via Telegram inline callback query button click', async () => {
    // 1. Ingest campaign task into AWAITING_APPROVAL via webhook
    const ingressRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2001,
        message: {
          message_id: 701,
          from: { id: 9988, is_bot: false, first_name: 'KAAE Operator' },
          chat: { id: 9988, type: 'private' },
          text: 'KAAE 2026 Institutional Quality Accreditation Announcement',
        },
      }),
    });
    expect(ingressRes.status).toBe(201);
    const ingressBody = await ingressRes.json();
    const taskId = ingressBody.task.id;
    expect(ingressBody.task.status).toBe('AWAITING_APPROVAL');

    // 2. Compute cryptographic action signature
    const signature = computeActionSignature(taskId, 'approve');

    // 3. Simulate Telegram inline button callback query
    const callbackRes = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2002,
        callback_query: {
          id: 'cbq_approve_9988',
          from: { id: 9988, is_bot: false, first_name: 'KAAE Operator' },
          message: {
            message_id: 702,
            chat: { id: 9988, type: 'private' },
          },
          data: `approve:${taskId}:${signature}`,
        },
      }),
    });

    expect(callbackRes.status).toBe(200);
    const cbResult = await callbackRes.json();
    expect(cbResult.ok).toBe(true);
    expect(cbResult.action).toBe('approve');
    expect(cbResult.status).toBe('COMPLETE');
    expect(cbResult.publishRes).toBeDefined();
    expect(cbResult.publishRes.driveFolderUrl).toContain('drive.google.com');
    expect(cbResult.publishRes.sheetRowUrl).toContain('docs.google.com/spreadsheets');
    expect(cbResult.publishRes.filesCount).toBe(12);

    // 4. Verify task state in store is COMPLETE
    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('COMPLETE');

    // 5. Verify omnichannel publication receipt was stored
    const receiptRes = await app.request(`/tasks/${taskId}/publication-receipt`);
    expect(receiptRes.status).toBe(200);
    const receipt = await receiptRes.json();
    expect(receipt.receipt.files.length).toBe(12);
  });

  it('rejects tampered Telegram callback query with 403 Forbidden', async () => {
    // 1. Create a task
    const ingressRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2010,
        message: {
          message_id: 710,
          from: { id: 9988, is_bot: false, first_name: 'Tamper Tester' },
          chat: { id: 9988, type: 'private' },
          text: 'Campaign for security verification',
        },
      }),
    });
    const ingressBody = await ingressRes.json();
    const taskId = ingressBody.task.id;

    // 2. Dispatch callback query with forged signature
    const callbackRes = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2011,
        callback_query: {
          id: 'cbq_fake_111',
          from: { id: 9988, is_bot: false, first_name: 'Adversary' },
          message: { message_id: 711, chat: { id: 9988 } },
          data: `approve:${taskId}:bad_forged_hash_value`,
        },
      }),
    });

    expect(callbackRes.status).toBe(403);
    const err = await callbackRes.json();
    expect(err.title).toBe('Forbidden');
  });

  it('requests design revision via Telegram inline callback query button click', async () => {
    const ingressRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2020,
        message: {
          message_id: 720,
          from: { id: 9988, is_bot: false, first_name: 'Reviewer' },
          chat: { id: 9988, type: 'private' },
          text: 'Campaign requiring revisions',
        },
      }),
    });
    const taskId = (await ingressRes.json()).task.id;

    const signature = computeActionSignature(taskId, 'revision');

    const callbackRes = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2021,
        callback_query: {
          id: 'cbq_rev_222',
          from: { id: 9988, is_bot: false, first_name: 'Reviewer' },
          message: { message_id: 721, chat: { id: 9988 } },
          data: `revision:${taskId}:${signature}`,
        },
      }),
    });

    expect(callbackRes.status).toBe(200);
    const cbResult = await callbackRes.json();
    expect(cbResult.ok).toBe(true);
    expect(cbResult.action).toBe('revision');
    expect(cbResult.status).toBe('IN_PROGRESS');

    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('IN_PROGRESS');
  });

  it('approves and publishes task via Telegram slash command /approve <taskId>', async () => {
    const ingressRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2030,
        message: {
          message_id: 730,
          from: { id: 9988, is_bot: false, first_name: 'Cmd Tester' },
          chat: { id: 9988, type: 'private' },
          text: 'Quick slash command task',
        },
      }),
    });
    const taskId = (await ingressRes.json()).task.id;

    // Send /approve <taskId> command
    const cmdRes = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2031,
        message: {
          message_id: 731,
          from: { id: 9988, is_bot: false, first_name: 'Cmd Tester' },
          chat: { id: 9988, type: 'private' },
          text: `/approve ${taskId}`,
        },
      }),
    });

    expect(cmdRes.status).toBe(200);
    const cmdResult = await cmdRes.json();
    expect(cmdResult.ok).toBe(true);
    expect(cmdResult.action).toBe('approve');
    expect(cmdResult.status).toBe('COMPLETE');
    expect(cmdResult.publishRes.driveFolderUrl).toContain('drive.google.com');

    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('COMPLETE');
  });

  it('logs revision via Telegram slash command /revise <taskId> <notes>', async () => {
    const ingressRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2040,
        message: {
          message_id: 740,
          from: { id: 9988, is_bot: false, first_name: 'Rev Tester' },
          chat: { id: 9988, type: 'private' },
          text: 'Slash command revision test task',
        },
      }),
    });
    const taskId = (await ingressRes.json()).task.id;

    const cmdRes = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2041,
        message: {
          message_id: 741,
          from: { id: 9988, is_bot: false, first_name: 'Rev Tester' },
          chat: { id: 9988, type: 'private' },
          text: `/revise ${taskId} Increase Kurdish headline contrast and replace accent color`,
        },
      }),
    });

    expect(cmdRes.status).toBe(200);
    const cmdResult = await cmdRes.json();
    expect(cmdResult.ok).toBe(true);
    expect(cmdResult.action).toBe('revision');
    expect(cmdResult.status).toBe('IN_PROGRESS');

    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('IN_PROGRESS');
  });

  it('executes full omnichannel publish on WhatsApp action callback with publish=true', async () => {
    // 1. Ingest task into AWAITING_APPROVAL
    const ingressRes = await app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': telegramSecret,
      },
      body: JSON.stringify({
        update_id: 2050,
        message: {
          message_id: 750,
          from: { id: 9988, is_bot: false, first_name: 'WA Tester' },
          chat: { id: 9988, type: 'private' },
          text: 'WhatsApp auto-publish campaign test',
        },
      }),
    });
    const taskId = (await ingressRes.json()).task.id;

    // 2. Compute signature
    const sig = computeActionSignature(taskId, 'approve');

    // 3. Trigger WhatsApp action callback with publish=true
    const actionUrl = `/api/webhooks/whatsapp/actions?taskId=${taskId}&action=approve&sig=${sig}&publish=true&phone=%2B9647501234567`;
    const cbRes = await app.request(actionUrl, { method: 'GET' });
    expect(cbRes.status).toBe(200);
    const htmlText = await cbRes.text();
    expect(htmlText).toContain('کەمپینەکە بەسەرکەوتوویی پەسەندکرا و بڵاوکرایەوە');
    expect(htmlText).toContain('Google Drive');
    expect(htmlText).toContain('Google Sheets');

    // 4. Task status should be COMPLETE
    const taskRes = await app.request(`/v1/tasks/${taskId}`);
    const task = await taskRes.json();
    expect(task.status).toBe('COMPLETE');
  });
});
