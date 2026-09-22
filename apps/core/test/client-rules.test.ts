import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, withRlsContext, ClientRulesRepository, formatClientRulesForPrompt } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * A rule the office states ("from now on, the logo bottom-right") must reach every later design
 * for that client. On 2026-09-23 the client_rules table had no reader and no writer, and the studio
 * briefed every design from one fixed string in kaae-reference.json.
 */
describe.skipIf(!url)('standing client rules', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const actorId = '00000000-0000-4000-b000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, userId: actorId, role: 'operator' } as const;
  afterAll(() => db.destroy());

  const repo = <T>(fn: (r: ClientRulesRepository) => Promise<T>) =>
    withRlsContext(db, scope, (trx) => fn(new ClientRulesRepository(trx)));

  it('saves a rule once, lists it for the client, and stops applying it when removed', async () => {
    const words = `From now on put the logo bottom-right ${randomUUID().slice(0, 6)}`;
    const first = await repo((r) => r.save({ tenantId, clientId, humanRule: words, category: 'logo', source: { kind: 'telegram_message', id: randomUUID() } }));
    expect(first.created).toBe(true);
    // The same words again, differently spaced and cased, are the same rule.
    const again = await repo((r) => r.save({ tenantId, clientId, humanRule: `  ${words.toUpperCase()}. `, source: { kind: 'telegram_message', id: randomUUID() } }));
    expect(again.created).toBe(false);
    expect(again.rule.id).toBe(first.rule.id);

    const active = await repo((r) => r.listActive(tenantId, clientId));
    expect(active.filter((x) => x.humanRule === words)).toHaveLength(1);
    expect(formatClientRulesForPrompt(active)).toContain(words);

    const removed = await repo((r) => r.deactivate(tenantId, clientId, first.rule.id));
    expect(removed?.id).toBe(first.rule.id);
    expect((await repo((r) => r.listActive(tenantId, clientId))).some((x) => x.id === first.rule.id)).toBe(false);
    // Removing it twice changes nothing.
    expect(await repo((r) => r.deactivate(tenantId, clientId, first.rule.id))).toBeUndefined();
  });

  it("reaches the studio's system prompt and the brief for that client's designs", async () => {
    const words = `Always set the Kurdish title in Noto Naskh Arabic ${randomUUID().slice(0, 6)}`;
    const saved = await repo((r) => r.save({ tenantId, clientId, humanRule: words, category: 'typography', source: { kind: 'telegram_message', id: randomUUID() } }));
    try {
      const service = new DesignStudioService(db, undefined, { apiKey: 'test-key' });
      const run = {
        id: randomUUID(),
        task_id: randomUUID(),
        client_id: clientId,
        tier: 'standard',
        status: 'brief',
        stages: '{}',
        request: JSON.stringify({ width: 1080, height: 1350, instructions: 'x', copyBlocks: [{ text: 'X', script: 'latin' }], logoAspect: 1 }),
      };
      const s = { tenantId, actorId };
      const base = (service as any).createStageContext(s, run, 'brief', { maxUsd: 1, maxCalls: 4, spentUsd: 0, calls: 0 }, async () => {});
      const ctx = await (service as any).withClientRules(s, base);
      expect(ctx.promotedRules).toContain(words);
      expect(ctx.promotedRules.startsWith('For dark institutional invitations')).toBe(true);
      expect(ctx.clientRules).toContain(words);

      // Another client's designs do not get it.
      const other = await (service as any).withClientRules(s, { ...base, clientId: randomUUID(), promotedRules: 'base', clientRules: undefined });
      expect(other.promotedRules).not.toContain(words);
    } finally {
      await repo((r) => r.deactivate(tenantId, clientId, saved.rule.id));
    }
  });
});
