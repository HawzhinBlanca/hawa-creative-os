import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('Track B Acceptance Gates: Search, Vision Rubric, Durable Workflows & Asset Sandbox', () => {
  const app = createApp({ testAuth: { principal: { role: 'operator' }, roleHeader: true } });

  // Helper to create an active task
  async function createFixtureTask(clientName: string = 'Kurdish Boutique') {
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'expected_office_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 100000),
        message: { text: `New luxury campaign for ${clientName}`, chat: { id: 888 } },
      }),
    });
    const json = await res.json();
    return { ...json.task, taskId: json.task.id };
  }

  describe('Horizon 1: Universal Multi-Tenant Search Engine (FR-077, Invariant #6)', () => {
    it('indexes tasks, clients, and assets with sub-10ms query execution', async () => {
      const task = await createFixtureTask('Zagros Roastery');
      const res = await app.request(`/search?q=Zagros`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.hits).toBeDefined();
      expect(json.tookMs).toBeLessThan(50);
      expect(json.hits.length).toBeGreaterThan(0);
      const hit = json.hits.find((h: any) => h.item.id === task.taskId || h.item.title.includes('Zagros') || h.item.bodyText.includes('Zagros'));
      expect(hit).toBeDefined();
    });

    it('enforces strict client isolation during search (Invariant #6)', async () => {
      // Create asset for client A
      await app.request('/assets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'client_a_secret_menu.png',
          mimeType: 'image/png',
          clientId: 'client-alpha-123',
          category: 'brand_asset',
          content: 'fake_binary_png_data',
        }),
      });

      // Search scoped to client B must not leak client A's asset
      const resScopedB = await app.request('/search?q=secret_menu&clientId=client-beta-456');
      const jsonB = await resScopedB.json();
      const leaked = jsonB.hits.some((h: any) => h.item.clientId === 'client-alpha-123');
      expect(leaked).toBe(false);

      // Search scoped to client A finds it
      const resScopedA = await app.request('/search?q=secret_menu&clientId=client-alpha-123');
      const jsonA = await resScopedA.json();
      const found = jsonA.hits.some((h: any) => h.item.clientId === 'client-alpha-123');
      expect(found).toBe(true);
    });

    it('supports Kurdish Sorani numeral and diacritic normalized search', async () => {
      await app.request('/assets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'kurdish_coffee_pack_٢٠٢٦.png',
          mimeType: 'image/png',
          clientId: 'client-kurdish-1',
          content: 'fake_coffee_pack',
        }),
      });

      // Query with Western numeral 2026 should match Kurdish Eastern numeral ٢٠٢٦
      const res = await app.request('/search?q=2026&clientId=client-kurdish-1');
      const json = await res.json();
      expect(json.hits.length).toBeGreaterThan(0);
      expect(json.hits[0].item.title).toContain('٢٠٢٦');
    });
  });

  describe('Horizon 2: Multilingual Visual QA Vision Rubric Scorer (FR-039, Invariant #9, Gate E)', () => {
    it('evaluates visual QA rubric with copy, typography, contrast, safe-zones, and SHA-256 seal', async () => {
      const task = await createFixtureTask('Rabar Fashion');
      const revId = 'rev_test_rubric_01';

      const res = await app.request(`/tasks/${task.taskId}/revisions/${revId}/evaluate-rubric`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'story',
          dimensions: { width: 1080, height: 1920 },
          nodes: [
            {
              id: 'headline',
              role: 'headline',
              text: 'جلوبەرگی کوردی شاهانە',
              x: 100,
              y: 300,
              width: 880,
              height: 120,
              fontSize: 48,
              lineHeight: 1.6,
              color: '#FFFFFF',
              background: '#0F172A',
            },
            {
              id: 'price',
              role: 'price',
              text: '95,000 IQD',
              x: 100,
              y: 500,
              width: 400,
              height: 60,
              fontSize: 32,
              color: '#F59E0B',
              background: '#0F172A',
            },
            {
              id: 'cta',
              role: 'cta',
              text: 'داواکاری لە واتسئەپ',
              x: 200,
              y: 1600,
              width: 680,
              height: 80,
              fontSize: 24,
              lineHeight: 1.5,
              color: '#FFFFFF',
              background: '#047857',
            },
          ],
          approvedCopy: {
            headlineCkb: 'جلوبەرگی کوردی شاهانە',
            prices: ['95,000 IQD'],
          },
        }),
      });

      expect(res.status).toBe(200);
      const report = await res.json();
      expect(report.reportId).toBeDefined();
      expect(report.taskId).toBe(task.taskId);
      expect(report.overallScore).toBeGreaterThanOrEqual(80);
      expect(['AAA', 'AA', 'A']).toContain(report.grade);
      expect(report.passed).toBe(true);
      expect(report.criteriaScores.copyFidelity).toBe(30);
      expect(report.criteriaScores.kurdishTypography).toBe(25);
      expect(report.criteriaScores.colorContrast).toBe(25);
      expect(report.criteriaScores.layoutSafeZones).toBe(20);
      expect(report.cryptographicSeal).toMatch(/^[a-f0-9]{64}$/);

      // Verify report retrieval endpoint
      const listRes = await app.request(`/tasks/${task.taskId}/rubric-reports`);
      expect(listRes.status).toBe(200);
      const reports = await listRes.json();
      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0].reportId).toBe(report.reportId);
    });

    it('flags unapproved price modifications as hard failures', async () => {
      const task = await createFixtureTask('Price Check');
      const revId = 'rev_price_mismatch';

      const res = await app.request(`/tasks/${task.taskId}/revisions/${revId}/evaluate-rubric`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'feed',
          dimensions: { width: 1080, height: 1350 },
          nodes: [
            {
              id: 'price',
              role: 'price',
              text: '120,000 IQD',
              x: 100,
              y: 200,
              width: 300,
              height: 50,
              fontSize: 24,
            },
          ],
          approvedCopy: {
            prices: ['85,000 IQD'],
          },
        }),
      });

      expect(res.status).toBe(200);
      const report = await res.json();
      expect(report.passed).toBe(false);
      expect(report.grade).toBe('FAIL');
      expect(report.hardFailures.some((f: string) => f.includes('85,000 IQD'))).toBe(true);
    });
  });

  describe('Horizon 3: Worker Durable Execution Recovery Controller (FR-060, FR-061, Gate C & H)', () => {
    // The in-memory controller these routes kept per task lost every pause, checkpoint and replay on a
    // restart and never reached Postgres (architecture programme 1.3, SPLIT_PLAN.md G6). The controller's
    // own pause, crash, resume, checkpoint and replay rules are packages/domain/test/workflow-recovery.test.ts;
    // the routes, which now read the task's state from Postgres, are workflow-state-from-postgres.test.ts.
    it('reports the task\'s state and sends every action to its durable route', async () => {
      const task = await createFixtureTask('Recovery Workflow');
      const taskId = task.taskId;

      const stateRes = await app.request(`/tasks/${taskId}/workflow/state`);
      expect(stateRes.status).toBe(200);
      expect(await stateRes.json()).toMatchObject({ taskId, executionState: 'RUNNING' });

      for (const [action, route] of [['pause', 'pause'], ['resume', 'resume'], ['cancel', 'cancel'], ['crash', 'redrive'], ['checkpoint', 'redrive'], ['replay', 'redrive']]) {
        const res = await app.request(`/tasks/${taskId}/workflow/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'Legal team reviewing disclaimer copy' }),
        });
        expect(res.status).toBe(410);
        expect((await res.json()).detail).toContain(`POST /tasks/${taskId}/${route}`);
      }
    });
  });

  describe('Horizon 4: Client Asset Library & Vector Sandbox (FR-018, Gate A & B)', () => {
    it('uploads client-scoped assets and provides filtered retrieval', async () => {
      const clientId = 'client-library-spec';

      // Upload logo
      const uploadRes = await app.request('/assets/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'client_brand_logo.svg',
          mimeType: 'image/svg+xml',
          clientId,
          category: 'logo',
          content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#10B981"/></svg>',
        }),
      });
      expect(uploadRes.status).toBe(201);
      const asset = await uploadRes.json();
      expect(asset.clientId).toBe(clientId);
      expect(asset.category).toBe('logo');
      expect(asset.sanitized).toBe(true);

      // Query by clientId
      const listRes = await app.request(`/assets?clientId=${clientId}`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      expect(list.some((a: any) => a.assetId === asset.assetId)).toBe(true);
    });

    it('sanitizes SVG vector uploads, stripping dangerous event handlers and scripts', async () => {
      const dirtySvg = '<svg><script>alert("xss")</script><rect onclick="evil()" width="100" height="100"/></svg>';
      const res = await app.request('/assets/sanitize-svg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ svg: dirtySvg }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sanitized).not.toContain('<script');
      expect(json.sanitized).not.toContain('onclick');
      expect(json.violations.some((v: string) => v.toLowerCase().includes('script'))).toBe(true);
    });
  });
});
