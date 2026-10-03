import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, withRlsContext, ClientRulesRepository } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { persistClientDnaFixture } from './fixtures/persisted-client-dna.js';

/**
 * ADR-291: a rule the office promotes from its feedback (governed learning, ADR-012/193) is written
 * into the client's DNA row, guidelines.layoutRules. KAAE's studio runs read the packaged reference
 * (kaae-reference.json) and never that row, so until ADR-291 a promoted KAAE rule was stored, shown
 * in the Desk as active, and reached no design.
 *
 * These go through Core's own routes (propose, promote, roll back) and the studio's own stage-context
 * build, against the isolated test database. No model is called.
 */
const url = process.env.TEST_DATABASE_URL;
const tenantId = '00000000-0000-4000-a000-000000000001';
const operatorId = '00000000-0000-4000-b000-000000000001';
const kaae = 'c1000000-0000-4000-8000-000000000002';

describe.skipIf(!url)('ADR-291: rules learned from office feedback reach the next draft', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const app = createAppWithClientFixtures({ db });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };
  const s = { tenantId, actorId: operatorId };
  afterAll(() => db.destroy());

  beforeAll(async () => {
    await persistClientDnaFixture(app, kaae, headers);
  });

  const propose = async (ruleText: string) => {
    const res = await app.request(`/v1/clients/${kaae}/candidate-rules/propose`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ title: ruleText.slice(0, 60), category: 'layout', ruleText }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).proposal as { id: string; ruleText: string };
  };
  const moderate = async (ruleId: string, action: 'promote' | 'rollback') => {
    const res = await app.request(`/v1/clients/${kaae}/candidate-rules/${ruleId}/${action}`, { method: 'POST', headers, body: JSON.stringify({ reason: `ADR-291 ${action}` }) });
    if (res.status !== 200) throw new Error(`${action} ${res.status}: ${await res.text()}`);
  };

  /** The stage context a KAAE studio run builds, with the rules in force when it started. */
  const kaaeStageContext = async (startedAt: Date) => {
    const service = new DesignStudioService(db, undefined, { apiKey: 'test-key' });
    const { reference, logo } = await resolveClientDesignReference(db, s, kaae);
    expect(reference.status).toBe('reference_for_draft_not_release_approval');
    const run = {
      id: randomUUID(), task_id: randomUUID(), client_id: kaae, tier: 'standard', status: 'brief', stages: '{}', created_at: startedAt,
      request: JSON.stringify({ width: 1080, height: 1350, instructions: 'x', copyBlocks: [{ text: 'X', script: 'latin' }], logoAspect: 1,
        clientId: kaae, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
        logoSha256: createHash('sha256').update(logo).digest('hex') }),
    };
    const base = await (service as any).createStageContext(s, run, 'brief', { maxUsd: 1, maxCalls: 4, spentUsd: 0, calls: 0 }, async () => {});
    return (service as any).withClientRules(s, base, startedAt);
  };

  it('a promoted KAAE rule is in the studio prompts and the brief\'s standing rules', async () => {
    const words = `Keep KAAE titles in capital letters ${randomUUID().slice(0, 8)}`;
    const proposal = await propose(words);
    await moderate(proposal.id, 'promote');
    const ctx = await kaaeStageContext(new Date());
    // Every stage's system prompt (promotedRules) and the standing-rules channel the brief turns
    // into enforced style values (clientRules) carry it, quoted as data.
    expect(ctx.promotedRules).toContain(`"${words}"`);
    expect(ctx.clientRules).toContain(`"${words}"`);
    // The packaged reference's own house rules stay first.
    expect(ctx.promotedRules.startsWith('KAAE Brand Guidelines, Excellence Edition (2025), light first.')).toBe(true);
  });

  it('is read as it stood when the run started: a later promotion waits, a rollback before the start removes it', async () => {
    const early = await propose(`Rollback check ${randomUUID().slice(0, 8)}`);
    await moderate(early.id, 'promote');
    const startedAt = new Date();
    await new Promise((r) => setTimeout(r, 25));
    const late = await propose(`Late promotion ${randomUUID().slice(0, 8)}`);
    await moderate(late.id, 'promote');
    await moderate(early.id, 'rollback');
    const frozen = await kaaeStageContext(startedAt);
    expect(frozen.clientRules).toContain(early.ruleText);
    expect(frozen.clientRules).not.toContain(late.ruleText);
    const now = await kaaeStageContext(new Date());
    expect(now.clientRules).not.toContain(early.ruleText);
    expect(now.clientRules).toContain(late.ruleText);
  });

  it('merges learned and standing rules into one list, oldest first, so the later one wins', async () => {
    const learned = await propose(`Learned first ${randomUUID().slice(0, 8)}`);
    await moderate(learned.id, 'promote');
    await new Promise((r) => setTimeout(r, 25));
    const standing = `Standing second ${randomUUID().slice(0, 8)}`;
    const saved = await withRlsContext(db, { tenantId, userId: operatorId, role: 'operator' }, (trx) =>
      new ClientRulesRepository(trx).save({ tenantId, clientId: kaae, humanRule: standing, category: 'layout', source: { kind: 'telegram_message', id: randomUUID() } }));
    try {
      const ctx = await kaaeStageContext(new Date());
      const lines = String(ctx.clientRules).split('\n');
      const at = (t: string) => lines.findIndex((l) => l.includes(t));
      expect(at(learned.ruleText)).toBeGreaterThan(0);
      expect(at(standing)).toBeGreaterThan(at(learned.ruleText));
      // Numbered once, as one list.
      expect(lines.filter((l) => /^\d+\. "/.test(l)).map((l) => Number(l.split('.')[0]))).toEqual(
        lines.filter((l) => /^\d+\. "/.test(l)).map((_, i) => i + 1));
    } finally {
      await withRlsContext(db, { tenantId, userId: operatorId, role: 'operator' }, (trx) => new ClientRulesRepository(trx).deactivate(tenantId, kaae, saved.rule.id));
    }
  });

  it('the Desk\'s rule list says, per rule, whether it is applied by code, only told to a model, or dropped', async () => {
    const promoted = await propose(`Metric promoted ${randomUUID().slice(0, 8)}`);
    await moderate(promoted.id, 'promote');
    const res = await app.request(`/v1/clients/${kaae}/candidate-rules`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    const effect = body.ruleEffect;
    expect(effect).toMatchObject({ clientId: kaae, reference: 'packaged' });
    const byText = (t: string) => effect.rules.find((r: { text: string }) => r.text === t);
    // The promotion reaches the models (it is prompt text; no code reads it).
    expect(byText(promoted.ruleText)).toMatchObject({ source: 'learned_rule', status: 'prompt_only' });
    // A DNA layout rule nobody promoted is still not read for KAAE: the packaged reference is.
    const fixtureRule = effect.rules.find((r: { source: string }) => r.source === 'dna_layout_rule');
    expect(fixtureRule).toMatchObject({ status: 'dropped' });
    expect(fixtureRule.note).toMatch(/packaged reference/);
    // The DNA's palette is the guideline's, the same set the packaged reference enforces.
    expect(effect.rules.find((r: { kind?: string }) => r.kind === 'palette')).toMatchObject({ source: 'dna_brand_value', status: 'applied_deterministically' });
    const total = effect.counts.applied_deterministically + effect.counts.prompt_only + effect.counts.dropped;
    expect(total).toBe(effect.rules.length);
  });
});

