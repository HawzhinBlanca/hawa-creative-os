import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, withRlsContext, sql } from '../packages/db/src/index.js';
import { classifyInboundTelegramMessage } from '../apps/core/src/services/telegram-classifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const SYSTEM_AUTOMATION_USER_ID = '00000000-0000-4000-b000-000000000002';

async function main() {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://127.0.0.1:54332/hawa';
  const db = createDb(dbUrl);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required for live F07 classification proof');
    process.exit(1);
  }

  // Fetch recent task and its real Canva exported PNG
  console.log('Fetching active task and preview image from database...');
  const taskRow = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'administrator' }, async (trx) => {
    return await sql<any>`
      SELECT t.id, t.title, t.description,
        (SELECT encode(e.content, 'base64') FROM hawa.canva_export_bytes e WHERE e.task_id = t.id AND e.format = 'png' ORDER BY e.created_at DESC LIMIT 1) AS preview_image
      FROM hawa.tasks t
      WHERE t.client_id IS NOT NULL
      ORDER BY t.created_at DESC LIMIT 1
    `.execute(trx);
  });

  const activeTask = taskRow.rows[0];
  if (!activeTask) {
    console.error('No active task found in database');
    process.exit(1);
  }

  console.log(`Active task: ${activeTask.id} - ${activeTask.title}`);
  console.log(`Preview image present: ${Boolean(activeTask.preview_image)} (length: ${activeTask.preview_image?.length || 0})`);

  const recentTask = {
    id: activeTask.id,
    title: activeTask.title,
    rawText: activeTask.description,
    previewImageBase64: activeTask.preview_image,
  };

  const testMessages = [
    // 5 Feedback messages without old keywords
    {
      expected: 'feedback',
      text: 'The aesthetic feels too sterile, can we give it more warmth and organic depth?',
      lang: 'en',
    },
    {
      expected: 'feedback',
      text: 'ئەم بەشەی ناونیشانەکە زۆر گەورەیە و سەرنج دەبات، پێویستە کەمێک نەرمتر و هاوسەنگتر بێت لەگەڵ پەڕەکەدا',
      lang: 'ckb',
    },
    {
      expected: 'feedback',
      text: 'The visual weight at the bottom is competing with the institutional seal, please rebalance it',
      lang: 'en',
    },
    {
      expected: 'feedback',
      text: 'دەتوانیت باگراوندەکە کەمێک زیندووتر بکەیت بۆ ئەوەی ڕەنگ بداتەوە بە بۆنەکە؟',
      lang: 'ckb',
    },
    {
      expected: 'feedback',
      text: 'It needs a more prestigious, commemorative mood rather than feeling like a corporate flyer',
      lang: 'en',
    },

    // 3 New briefs with complete copy/event details
    {
      expected: 'new_brief',
      text: 'We cordially invite faculty members to the Annual Higher Education Symposium on October 25, 2026 at the Grand Millennium Hotel, Sulaimani. Keynote address begins at 10:00 AM.',
      lang: 'en',
    },
    {
      expected: 'new_brief',
      text: 'دەستەی باڵای دڵنیایی جۆری لە پەروەردە بانگهێشتت دەکات بۆ ئامادەبوون لە مەراسیمی دەستپێکردنی ساڵی ئەکادیمی ٢٠٢٦-٢٠٢٧ لە هۆڵی کۆنگرێس لە زانکۆی سەلاحەدین، ڕێکەوتی ١٥ی تشرینی یەکەم کاتژمێر ٩:٣٠ی بەیانی.',
      lang: 'ckb',
    },
    {
      expected: 'new_brief',
      text: 'Invitation: The Ministry of Higher Education and Scientific Research announces the National Quality Framework Forum.\nDate: November 12, 2026.\nLocation: Rotana Hotel, Erbil.\nTime: 2:00 PM.\nRSVP Required.',
      lang: 'en',
    },

    // 2 Questions
    {
      expected: 'question',
      text: 'How much does it cost to generate an export with our official institutional seal?',
      lang: 'en',
    },
    {
      expected: 'question',
      text: 'ئایا دەتوانم فۆرماتی پی دی ئێف بۆ چاپکردنی باجەکان وەربگرم؟',
      lang: 'ckb',
    },
  ];

  console.log(`\nExecuting live classification tournament on gpt-6-astra (${testMessages.length} cases)...`);

  const results: Array<{
    message: string;
    expected: string;
    got: string;
    callId: string;
    confidence: number;
    reason: string;
    inputTokens: number;
    outputTokens: number;
    match: boolean;
  }> = [];

  const callReceipts: any[] = [];

  for (let i = 0; i < testMessages.length; i++) {
    const item = testMessages[i];
    console.log(`\n[${i + 1}/${testMessages.length}] Classifying: "${item.text.slice(0, 60)}..."`);

    const classification = await classifyInboundTelegramMessage(
      {
        messageText: item.text,
        recentTask,
        hasReplyTo: false,
      },
      { apiKey, timeoutMs: 30000 }
    );

    const callReceipt = classification.callReceipt;
    const got = classification.kind;
    const match = got === item.expected;

    console.log(`  -> Expected: ${item.expected}, Got: ${got} (${match ? 'PASS' : 'FAIL'}), Confidence: ${classification.confidence}, ID: ${callReceipt?.id}`);

    results.push({
      message: item.text.replace(/[\r\n]+/g, ' '),
      expected: item.expected,
      got,
      callId: callReceipt?.id || 'offline',
      confidence: classification.confidence,
      reason: classification.reason,
      inputTokens: callReceipt?.inputTokens || 0,
      outputTokens: callReceipt?.outputTokens || 0,
      match,
    });

    callReceipts.push({
      index: i + 1,
      message: item.text,
      lang: item.lang,
      expected: item.expected,
      classification,
    });
  }

  const passCount = results.filter((r) => r.match).length;
  console.log(`\n========================================`);
  console.log(`Evaluation Results: ${passCount}/${testMessages.length} passed (${Math.round((passCount / testMessages.length) * 100)}%)`);
  console.log(`Zero feedback-as-brief: ${results.filter((r) => r.expected === 'feedback' && r.got === 'new_brief').length === 0}`);
  console.log(`========================================\n`);

  // Write F07_CLASSIFIER.csv
  const proofDir = path.join(ROOT, 'output/proofs/2026-09-16-flawless-system');
  fs.mkdirSync(proofDir, { recursive: true });

  const csvRows = [
    'message,expected,got,call_id,confidence,tokens_in,tokens_out,match',
    ...results.map((r) =>
      `"${r.message.replace(/"/g, '""')}",${r.expected},${r.got},${r.callId},${r.confidence},${r.inputTokens},${r.outputTokens},${r.match}`
    ),
  ];
  fs.writeFileSync(path.join(proofDir, 'F07_CLASSIFIER.csv'), csvRows.join('\n') + '\n', 'utf8');
  console.log(`Written F07_CLASSIFIER.csv to ${path.join(proofDir, 'F07_CLASSIFIER.csv')}`);

  // Write F07_RECEIPTS.json
  fs.writeFileSync(path.join(proofDir, 'F07_RECEIPTS.json'), JSON.stringify(callReceipts, null, 2), 'utf8');
  console.log(`Written F07_RECEIPTS.json to ${path.join(proofDir, 'F07_RECEIPTS.json')}`);

  await db.destroy();
}

main().catch((err) => {
  console.error('Error running F07 evaluation:', err);
  process.exit(1);
});
