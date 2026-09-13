import { describe, it, expect, vi, afterEach } from 'vitest';
afterEach(()=>vi.restoreAllMocks());
import { TelegramBridgeDaemon } from '../src/telegram-bridge.js';
import { computeActionSignature } from '../src/outbound-notifier.js';

describe('Telegram Bot & Bidirectional Feedback Engine', () => {
  it('formats an English preview card with canonical Desk deep link', () => {
    const bridge = new TelegramBridgeDaemon();
    const card = bridge.formatTaskPreviewCard({
      id: 'task-office-88',
      docId: 'doc-hyc-777',
      title: 'Summer Grand Opening',
      copy: '25% OFF all cold drinks!',
      status: 'AWAITING_APPROVAL',
      clientName: 'Aster Cafe',
    });

    expect(card.parse_mode).toBe('Markdown');
    expect(card.text).toContain('Task Ready for Operator Review');
    expect(card.text).toContain('Title:* Summer Grand Opening');
    expect(card.text).toContain('Client:* Aster Cafe');
    expect(card.reply_markup.inline_keyboard[0][0].text).toBe('✅ Approve & Publish');
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).toContain('approve:task-office-88:');
    expect(card.reply_markup.inline_keyboard[0][1].text).toBe('✏️ Request Revision');
    expect(card.reply_markup.inline_keyboard[0][1].callback_data).toContain('revision:task-office-88:');
    expect(card.reply_markup.inline_keyboard[1][0].text).toBe('⚡ Open Desk Studio');
  });

  it('formats an English publication receipt with Google Drive and Sheets links', () => {
    const bridge = new TelegramBridgeDaemon();
    const notice = bridge.formatPublicationNotice({
      id: 'task-office-88',
      title: 'Summer Grand Opening',
      driveUrl: 'https://drive.google.com/drive/folders/drive_deliverables_123',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_audit_row_456',
      workflowId: 'restate_wf_999',
    });

    expect(notice.parse_mode).toBe('Markdown');
    expect(notice.text).toContain('Deliverables Approved & Published');
    expect(notice.text).toContain('Google Drive Folder:* https://drive.google.com');
    expect(notice.text).toContain('Google Sheets Audit Row:* https://docs.google.com');
    expect(notice.text).toContain('Restate Workflow ID:* `restate_wf_999`');
  });

  it('handles English bot commands (/start, /status, /review)', async () => {
    const bridge = new TelegramBridgeDaemon({ botToken: 'mock_token' });
    bridge.start();

    // 1. /start command
    const startRes = bridge.handleCommand('/start', 123456);
    expect(startRes).not.toBeNull();
    expect(startRes?.text).toContain('Welcome to Hawa Creative OS Bot');

    // 2. /status command
    const statusRes = bridge.handleCommand('/status', 123456);
    expect(statusRes).not.toBeNull();
    expect(statusRes?.text).toContain('Hawa Telegram Bridge Status');
    expect(statusRes?.text).toContain('Mode:* `live_polling`');

    // 3. /review command
    const reviewRes = bridge.handleCommand('/review task-abc-99', 123456);
    expect(reviewRes).not.toBeNull();
    expect(reviewRes?.text).toContain('Task task-abc-99');
    expect(reviewRes?.text).toContain('http://localhost:4173/review?doc=task-abc-99');
  });

  it('processes incoming Telegram message and auto-dispatches bot command reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ok:true,result:{message_id:800,chat:{id:9876}}})));
    const bridge = new TelegramBridgeDaemon({botToken:'test'});
    bridge.clearSentMessages();

    const update = {
      update_id: 101,
      message: {
        message_id: 501,
        from: { id: 9876, is_bot: false, first_name: 'Hawzhin' },
        chat: { id: 9876, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/status',
      },
    };

    const result = await bridge.processUpdate(update);
    expect(result.processed).toBe(true);
    expect(result.botResponse).not.toBeNull();
    expect(result.botResponse?.text).toContain('Hawa Telegram Bridge Status');

    const sent = bridge.getSentMessages();
    expect(sent.length).toBe(1);
    expect(sent[0].chatId).toBe(9876);
    expect(sent[0].text).toContain('Hawa Telegram Bridge Status');
  });

  it('processes incoming Telegram callback query with verified signature and rejects forged signature', async () => {
    const bridge = new TelegramBridgeDaemon();
    const taskId = 'task-kaae-888';
    const validSig = computeActionSignature(taskId, 'approve');

    // 1. Forged signature rejected
    const forgedUpdate = {
      update_id: 102,
      callback_query: {
        id: 'cb-query-122',
        from: { id: 9876, is_bot: false, first_name: 'Hawzhin' },
        message: {
          message_id: 502,
          chat: { id: 9876, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'Campaign preview',
        },
        data: `approve:${taskId}:forged_signature_hash`,
      },
    };
    const forgedResult = await bridge.processUpdate(forgedUpdate as any);
    expect(forgedResult.processed).toBe(true);
    expect(forgedResult.botResponse?.errorCode).toBe('INVALID_SIGNATURE');

    // 2. Valid signature approved
    const validUpdate = {
      update_id: 103,
      callback_query: {
        id: 'cb-query-123',
        from: { id: 9876, is_bot: false, first_name: 'Hawzhin' },
        message: {
          message_id: 503,
          chat: { id: 9876, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'Campaign preview',
        },
        data: `approve:${taskId}:${validSig.slice(0, 16)}`,
      },
    };
    const validResult = await bridge.processUpdate(validUpdate as any);
    expect(validResult.processed).toBe(true);
    expect(validResult.botResponse?.action).toBe('approve');
    expect(validResult.botResponse?.taskId).toBe(taskId);
    expect(validResult.botResponse?.signature).toBe(validSig.slice(0, 16));
  });

  it('handles slash commands for two-way approval and revision', () => {
    const bridge = new TelegramBridgeDaemon();

    const approveCmd = bridge.handleCommand('/approve task-fast-101', 9876);
    expect(approveCmd).not.toBeNull();
    expect(approveCmd?.action).toBe('approve');
    expect(approveCmd?.taskId).toBe('task-fast-101');

    const reviseCmd = bridge.handleCommand('/revise task-fast-101 Increase logo size and use dark blue', 9876);
    expect(reviseCmd).not.toBeNull();
    expect(reviseCmd?.action).toBe('revision');
    expect(reviseCmd?.taskId).toBe('task-fast-101');
    expect(reviseCmd?.notes).toBe('Increase logo size and use dark blue');
  });
});
