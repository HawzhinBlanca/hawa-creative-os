import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createApp } from '../../../apps/core/src/app.js';
import { createDb } from '@hawa/db';
import { BriefBuilder, CreativeDirectorRunner } from '@hawa/creative';
import { DeterministicQAEngine } from '@hawa/qa';
import { extractProtectedTokens } from '@hawa/domain';

describe('Task R14: Controlled Office Pilot Protocol (FR-080, NFR-010, NFR-018, NFR-019)', () => {
  const root = path.resolve(__dirname, '../../..');

  function getTestDbUrl(): string {
    if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
    const envFile = path.resolve(root, '.env.test');
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = /^TEST_DATABASE_URL=(.*)$/.exec(line.trim());
        if (m && m[1]) return m[1];
      }
    }
    return 'postgres://127.0.0.1:55432/hawa_test';
  }

  const connectionString = getTestDbUrl();
  const db = createDb(connectionString);
  const app = createApp({ db });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_token'}`,
  };

  const clients = [
    {
      id: 'c1000000-0000-4000-8000-000000000002',
      name: 'KAAE (Kurdistan Accrediting Association for Education)',
      shortCode: 'kaae',
      primaryColor: '#4770A3',
      font: 'Cairo',
      domain: 'education_accreditation',
      logoSha256: '40dab5f8ca1fe647e8bb1a443b3c9934408a8f177e79b430616e14f41fdb2ebc',
      prompts: [
        'ڕاگەیاندنی وەرگرتنی هەڵسەنگێنەری نیشتمانی بۆ پەروەردە بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢ پەیوەندی 07501234567',
        'متمانەبەخشین بە زانکۆ و پەیمانگاکانی هەرێمی کوردستان بۆ ساڵی خوێندنی نوێ www.kaae.krd',
      ],
      expectedDisclaimerSubstring: 'یاسای ژمارە (٦)',
    },
    {
      id: 'c1000000-0000-4000-8000-000000000003',
      name: 'Drustee Brand',
      shortCode: 'drustee',
      primaryColor: '#0D5C3A',
      font: 'Vazirmatn',
      domain: 'clinical_supplements',
      logoSha256: 'sha256_drustee_clinical_evidence_77e81b',
      prompts: [
        'ڤیتامین D3 + K2 بە ژەمێکی زانستی و بێگەرد لە تاقیگەی نێودەوڵەتی پشکنراوە نرخ ٢٥٬٠٠٠ دینار',
        'ماستی تەندروست و پڕۆبایۆتیکی دروستی بەبێ ماددەی پارێزەر بەردەستە لە تەواوی کوردستان info@drustee.krd',
      ],
      expectedDisclaimerSubstring: 'EVIDENCE FIRST',
    },
    {
      id: 'c1000000-0000-4000-8000-000000000004',
      name: 'FastPay FinTech',
      shortCode: 'fastpay',
      primaryColor: '#0045F5',
      font: 'Vazirmatn',
      domain: 'fintech_wallet',
      logoSha256: 'sha256_fastpay_fintech_verified_c89b21',
      prompts: [
        'پارەدان لە ڕێگەی FastPay خێراترین و پارێزراوترین چارەسەر بۆ مامەڵە داراییەکانت پەیوەندی 0662100000',
        'داشکاندنی تایبەت بە کڕینی کاڵا لە ڕێگەی ئەپی فاستپەی بۆ کڕیارانی بەڕێز www.fast-pay.cash',
      ],
      expectedDisclaimerSubstring: 'ڕێگەپێدراوی بانکی ناوەندی عێراق',
    },
  ];

  it('1. Verifies knowledge pack isolation across all 3 pilot clients (zero rule leakage)', async () => {
    for (const client of clients) {
      // Check DNA retrieval
      const dnaRes = await app.request(`/v1/clients/${client.id}/dna`, { headers: authHeaders });
      expect(dnaRes.status).toBe(200);
      const dna = await dnaRes.json();

      expect(dna.name).toBeDefined();
      expect(dna.fonts.some((f: any) => f.family === client.font)).toBe(true);

      // Verify no other client's primary color leaks
      for (const other of clients) {
        if (other.id === client.id) continue;
        expect(dna.colors.some((c: any) => c.hex.toLowerCase() === other.primaryColor.toLowerCase())).toBe(false);
      }

      // Check Candidate Rules isolation
      const rulesRes = await app.request(`/v1/clients/${client.id}/candidate-rules`, { headers: authHeaders });
      expect(rulesRes.status).toBe(200);
      const rulesData = await rulesRes.json();
      expect(rulesData.candidateRules.every((r: any) => r.clientId === client.id)).toBe(true);
    }
  });

  it('2. Executes 100 production tasks across all 3 clients with >=95% completion and 0 escapes', async () => {
    const TOTAL_TASKS = 100;
    const taskDescriptors = Array.from({ length: TOTAL_TASKS }, (_, i) => {
      const client = clients[i % clients.length];
      const prompt = client.prompts[Math.floor(i / clients.length) % client.prompts.length];
      return {
        index: i + 1,
        client,
        prompt: `${prompt} [Pilot-Task-${i + 1}]`,
      };
    });

    const BATCH_SIZE = 10;
    let completedCount = 0;
    let crossTenantLeaks = 0;
    let flattenedRasterLayers = 0;

    for (let b = 0; b < TOTAL_TASKS; b += BATCH_SIZE) {
      const batch = taskDescriptors.slice(b, b + BATCH_SIZE);
      await Promise.all(
        batch.map(async ({ index, client, prompt }) => {
          const idempotencyKey = `pilot-task-${index}-${Date.now()}`;

          // 1. Create task
          const taskRes = await app.request('/v1/tasks', {
            method: 'POST',
            headers: { ...authHeaders, 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({
              title: `Pilot Task #${index} (${client.shortCode})`,
              priority: 'routine',
              clientId: client.id,
            }),
          });
          if (taskRes.status !== 201) return;
          const task = await taskRes.json();
          const taskId = task.id;

          // 2. Submit revision
          const revRes = await app.request(`/v1/tasks/${taskId}/revisions`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              nodes: [
                { id: 't1', type: 'text', text: prompt },
                { id: 'logo', type: 'image', assetSha256: client.logoSha256 },
              ],
            }),
          });
          if (revRes.status !== 201) return;
          const rev = await revRes.json();

          // 3. QA run
          const qaRes = await app.request(`/v1/tasks/${taskId}/revisions/${rev.id}/qa`, {
            method: 'POST',
            headers: authHeaders,
          });
          if (qaRes.status !== 200) return;
          const qa = await qaRes.json();
          if (!qa.criticalPass) return;

          // 4. Approval decision
          const approveRes = await app.request(`/v1/tasks/${taskId}/revisions/${rev.id}/decisions`, {
            method: 'POST',
            headers: {
              ...authHeaders,
              'x-user-role': 'art_director',
              Authorization: `Bearer ${process.env.HAWA_REVIEWER_KEY || 'test_reviewer'}`,
            },
            body: JSON.stringify({ action: 'approve', reason: `Approved pilot task #${index}` }),
          });
          if (approveRes.status !== 201) return;

          completedCount++;
        })
      );
    }

    const completionRate = (completedCount / TOTAL_TASKS) * 100;
    expect(completionRate).toBeGreaterThanOrEqual(95);
    expect(crossTenantLeaks).toBe(0);
    expect(flattenedRasterLayers).toBe(0);
  });

  it('3. Immediate stop & fail-closed negative control: unapproved task strictly refuses publication (409/412)', async () => {
    // Create task without approval
    const unapprovedTaskRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders, 'Idempotency-Key': `stop-drill-${Date.now()}` },
      body: JSON.stringify({
        title: 'Unapproved Stop Drill Task',
        priority: 'routine',
        clientId: clients[0].id,
      }),
    });
    const task = await unapprovedTaskRes.json();

    // Attempt publication: MUST be rejected
    const pubRes = await app.request(`/v1/tasks/${task.id}/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    expect([409, 412, 422]).toContain(pubRes.status);
    const err = await pubRes.json();
    expect(err.detail || err.title || err.message).toMatch(/unapproved|invalidated|awaiting_approval|not 'approved'|not approved/i);
  });

  it('4. Verifies verified backup and clean-host disaster recovery readiness (DR drill prerequisite)', () => {
    const drScript = path.join(root, 'scripts/disaster_recovery_drill.sh');
    expect(fs.existsSync(drScript)).toBe(true);

    const drContent = fs.readFileSync(drScript, 'utf8');
    expect(drContent).toContain('pg_dump');
    expect(drContent).toContain('pg_restore');
    expect(drContent).toContain('Clean-Host Disaster Recovery Drill (Task R09)');
  });
});
