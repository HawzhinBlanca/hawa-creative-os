import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

/**
 * Standing rules a client's office has given ("from now on, the logo bottom-right", a brand
 * guidelines document). They apply to every later design for that client until someone removes
 * them. The table existed from the first schema and nothing wrote or read it, so a rule said in
 * chat was applied to one revision and forgotten (reality check, 2026-09-23).
 */
export type ClientRuleCategory = 'typography' | 'colour' | 'layout' | 'logo' | 'copy' | 'imagery' | 'general';

export interface SaveClientRuleParams {
  tenantId: string;
  clientId: string;
  /** The rule in the words it was given, shown back to the office and to the models. */
  humanRule: string;
  category?: ClientRuleCategory;
  /** Structured parts code can enforce (a font family, a colour), when there are any. */
  machineRule?: Record<string, unknown>;
  /** Where it came from: a chat message, a guidelines document, Desk. */
  source: { kind: string; id: string; note?: string };
}

export interface ClientRule {
  id: string;
  clientId: string;
  humanRule: string;
  category: string;
  machineRule: Record<string, unknown>;
  createdAt: Date;
}

/** Case, spacing and trailing punctuation do not make a different rule. */
export function normalizeRuleText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/[.!؟?]+$/u, '').toLowerCase();
}

type RuleRow = { id: string; client_id: string; human_rule: string; category: string; machine_rule: unknown; created_at: Date };

const toRule = (row: RuleRow): ClientRule => ({
  id: row.id,
  clientId: row.client_id,
  humanRule: row.human_rule,
  category: row.category,
  machineRule: ((typeof row.machine_rule === 'string' ? JSON.parse(row.machine_rule) : row.machine_rule) || {}) as Record<string, unknown>,
  createdAt: row.created_at,
});

export class ClientRulesRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Saves an active rule. The same words said again return the rule already saved. */
  async save(params: SaveClientRuleParams, trx?: Kysely<Database>): Promise<{ rule: ClientRule; created: boolean }> {
    const db = trx || this.db;
    const humanRule = params.humanRule.replace(/\s+/g, ' ').trim();
    if (!humanRule) throw new Error('A client rule needs words');
    const ruleKey = `rule:${createHash('sha256').update(normalizeRuleText(humanRule)).digest('hex').slice(0, 24)}`;
    const existing = await db
      .selectFrom('client_rules')
      .selectAll()
      .where('tenant_id', '=', params.tenantId)
      .where('client_id', '=', params.clientId)
      .where('rule_key', '=', ruleKey)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (existing) return { rule: toRule(existing), created: false };

    const row = await db
      .insertInto('client_rules')
      .values({
        tenant_id: params.tenantId,
        client_id: params.clientId,
        rule_key: ruleKey,
        category: params.category || 'general',
        scope: 'client',
        machine_rule: JSON.stringify({ ...(params.machineRule || {}), source: params.source.kind }),
        human_rule: humanRule,
        status: 'active',
        effective_from: new Date(),
        project_id: null,
        dna_version_id: null,
        effective_until: null,
        supersedes_rule_id: null,
        created_by: null,
        approved_by: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('rule_evidence')
      .values({
        rule_id: row.id,
        source_kind: params.source.kind,
        source_id: params.source.id,
        note: params.source.note || null,
        feedback_event_id: null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    return { rule: toRule(row), created: true };
  }

  /** The client's active rules, oldest first, so a later rule reads as the one that wins. */
  async listActive(tenantId: string, clientId: string, trx?: Kysely<Database>): Promise<ClientRule[]> {
    const db = trx || this.db;
    const rows = await db
      .selectFrom('client_rules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('client_id', '=', clientId)
      .where('status', '=', 'active')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toRule);
  }

  /** Stops a rule applying. The row stays, so what was in force when is still known. */
  async deactivate(tenantId: string, clientId: string, ruleId: string, trx?: Kysely<Database>): Promise<ClientRule | undefined> {
    const db = trx || this.db;
    const row = await db
      .updateTable('client_rules')
      .set({ status: 'inactive', effective_until: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('client_id', '=', clientId)
      .where('id', '=', ruleId)
      .where('status', '=', 'active')
      .returningAll()
      .executeTakeFirst();
    return row ? toRule(row) : undefined;
  }
}

/**
 * The rules as the models read them: numbered, oldest first, with the order stated, because two
 * rules said weeks apart can disagree and the later one is what the office wants now.
 */
export function formatClientRulesForPrompt(rules: ClientRule[]): string {
  if (!rules.length) return '';
  return [
    'Standing rules from this client\'s office (authoritative for every design; when two disagree the later one wins; the current request\'s own instructions win over all of them):',
    ...rules.map((r, i) => `${i + 1}. ${r.humanRule}`),
  ].join('\n');
}
