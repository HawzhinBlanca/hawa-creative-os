import { readFile } from 'node:fs/promises';
import { creativeAssetPath } from '@hawa/creative';
import { ClientRulesRepository, formatClientRulesForPrompt, sql, withRlsContext, type ClientRule, type Database, type Kysely } from '@hawa/db';

/**
 * ADR-291: what an office brand rule does to the next draft, and the one place a stored rule was not
 * read at all.
 *
 * Rules reach a design through three stores:
 * - standing rules (`client_rules`: chat, a guidelines PDF), read by `withClientRules` into every
 *   studio stage's prompts;
 * - the DNA row's `guidelines.layoutRules`, where the Desk's rule list and governed learning's
 *   promotions are written; the studio reads them through the client's reference, so only a client
 *   whose reference IS its DNA row (not KAAE's packaged reference) had them;
 * - the DNA's structured values (palette, logo minimum width), which code enforces.
 *
 * No code reads the words of a rule. A rule changes a draft only as far as a model reads it (the
 * brief turns some into style values that preparation then enforces on model-drawn layouts). The
 * harness in apps/core/test/rule-effect-harness.test.ts measures that, kind by kind.
 */

type Db = Kysely<Database>;

/**
 * The rules governed learning had promoted for a client, and not rolled back, at a moment (now when
 * `at` is absent): the latest moderation of each candidate, as learning-recovery reads it, at or
 * before `at`. Oldest promotion first. In the shape of a standing rule so both read as one list.
 */
export async function listLearnedRulesInForceAt(db: Db, tenantId: string, clientId: string, at?: Date): Promise<ClientRule[]> {
  const until = at && !Number.isNaN(at.getTime()) ? at : null;
  const rows = (await sql<{ resource_id: string; action: string; data: any; occurred_at: Date }>`
    SELECT DISTINCT ON (resource_id) resource_id, action, data, occurred_at FROM hawa.audit_events
    WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND task_id IS NULL
      AND resource_type = 'candidate_rule'
      AND action IN ('client_rule.promoted', 'client_rule.dismissed', 'client_rule.rolled_back')
      AND (${until}::timestamptz IS NULL OR occurred_at <= ${until}::timestamptz)
    ORDER BY resource_id, coalesce((data->>'ruleRevision')::integer, 0) DESC, occurred_at DESC, id DESC`.execute(db)).rows;
  return rows
    .filter((row) => row.action === 'client_rule.promoted')
    .map((row) => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      const proposal = data?.proposal ?? {};
      return { row, text: typeof proposal.ruleText === 'string' ? proposal.ruleText.trim() : '', category: String(proposal.category || 'general') };
    })
    .filter((r) => r.text)
    .map(({ row, text, category }) => ({
      id: row.resource_id, clientId, humanRule: text, category, machineRule: { source: 'governed_learning' }, createdAt: new Date(row.occurred_at),
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** Standing and learned rules as one list, oldest first, so a later rule reads as the one that wins. */
export function mergeRulesByTime(...lists: ClientRule[][]): ClientRule[] {
  const seen = new Set<string>();
  return lists.flat()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .filter((r) => {
      const key = r.humanRule.replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The rules a run designs with, put where the stages read them: `clientRules` (the brief turns them
 * into enforced style values, the brief contract and the visual review name them) and appended to
 * `promotedRules` (every stage's system prompt, the layout model's house rules). Mutates the context.
 */
export function contextWithClientRules<T extends { promotedRules: string; clientRules?: string }>(ctx: T, rules: ClientRule[]): T {
  const text = formatClientRulesForPrompt(rules);
  if (!text) return ctx;
  ctx.clientRules = text;
  ctx.promotedRules = `${ctx.promotedRules}\n\n${text}`;
  return ctx;
}

/**
 * A run designs from the packaged reference (KAAE, ADR-115/238), not from its DNA row. Only a real
 * stage context answers this: a DNA client's reference pack names its DNA version.
 */
export function readsPackagedReference(referencePack: Record<string, unknown> | undefined): boolean {
  return Boolean(referencePack) && typeof referencePack!.dnaVersion !== 'number';
}

export type RuleEffectStatus = 'applied_deterministically' | 'prompt_only' | 'dropped';

export interface RuleEffectRow {
  /** Where the rule is stored. */
  source: 'standing_rule' | 'learned_rule' | 'dna_layout_rule' | 'dna_brand_value';
  /** For a structured DNA value: which one. */
  kind?: 'palette' | 'logo_minimum_width';
  text: string;
  status: RuleEffectStatus;
  note: string;
}

export interface ClientRuleEffect {
  clientId: string;
  /** What the studio designs this client from: its DNA row, the packaged reference, or nothing yet. */
  reference: 'client_dna' | 'packaged' | 'none';
  rules: RuleEffectRow[];
  counts: Record<RuleEffectStatus, number>;
}

/** Where a rule a model reads reaches it (ADR-291 section 2 has the file and line of each). */
export const RULE_PROMPT_LOCATIONS = [
  'brief: every stage system prompt (promotedRules) and, for standing and learned rules, the brief\'s instruction to turn them into enforced style values',
  'layout model prompt (layoutBriefV3), when a layout model is called; a KAAE text-only poster is composed and calls none',
  'visual review (Client design rules)',
] as const;

const PROMPT_NOTE = 'Only a model reads it (brief, layout model, visual review); no code reads its words, and the v3 judge is not shown it. Where the brief turns it into a style value (logo corner, typeface, title weight or colour, alignment, cards, dividers, background), preparation enforces that value on model-drawn layouts.';
/** ADR-291 section 4: what the composed KAAE poster takes from a rule. */
/** ADR-291 section 5: a DNA client's layout rules reach the system prompts only. */
const DNA_RULE_NOTE = 'Only a model reads it: the DNA\'s rule list is in every stage\'s system prompt, the layout model\'s house rules and the visual review. Unlike a standing rule, the brief is not asked to turn it into enforced style values and the brief contract does not name it; the v3 judge is not shown it.';
const PACKAGED_NOTE = `${PROMPT_NOTE} A text-only KAAE poster is composed from the guideline and takes only the background colour from it.`;

/**
 * Per client, its active rules and what each does to the next draft (ADR-291). Reads under the
 * caller's own RLS scope; a packaged reference is read from the creative assets.
 */
export async function clientRuleEffect(db: Db, scope: { tenantId: string; userId: string; role: string }, clientId: string): Promise<ClientRuleEffect> {
  const packaged = await packagedReferenceFor(clientId);
  const { standing, learned, dna } = await withRlsContext(db, { tenantId: scope.tenantId, clientId, userId: scope.userId, role: scope.role }, async (trx) => ({
    standing: await new ClientRulesRepository(trx).listActive(scope.tenantId, clientId),
    learned: await listLearnedRulesInForceAt(trx, scope.tenantId, clientId),
    dna: (await sql<{ dna: any }>`SELECT dna FROM hawa.client_dna_versions
      WHERE tenant_id = ${scope.tenantId}::uuid AND client_id = ${clientId}::uuid AND status = 'active'
      ORDER BY version DESC LIMIT 1`.execute(trx)).rows[0]?.dna,
  }));
  const d = (typeof dna === 'string' ? JSON.parse(dna) : dna) as Record<string, any> | undefined;
  const reference: ClientRuleEffect['reference'] = packaged ? 'packaged' : d ? 'client_dna' : 'none';
  const rows: RuleEffectRow[] = [];
  const noReference = 'This client has no studio reference yet, so no design is made for it.';

  for (const r of standing) {
    rows.push({ source: 'standing_rule', text: r.humanRule, status: reference === 'none' ? 'dropped' : 'prompt_only',
      note: reference === 'none' ? noReference : reference === 'packaged' ? PACKAGED_NOTE : PROMPT_NOTE });
  }
  const learnedTexts = new Set(learned.map((r) => r.humanRule));
  const layoutRules: string[] = Array.isArray(d?.guidelines?.layoutRules) ? d!.guidelines.layoutRules.filter((r: unknown) => typeof r === 'string') : [];
  for (const text of layoutRules) {
    const isLearned = learnedTexts.has(text);
    const source = isLearned ? 'learned_rule' : 'dna_layout_rule';
    if (reference === 'client_dna') rows.push({ source, text, status: 'prompt_only', note: DNA_RULE_NOTE });
    else if (isLearned) rows.push({ source, text, status: 'prompt_only', note: `${PACKAGED_NOTE} Read from its promotion record (ADR-291), because this client designs from its packaged reference.` });
    else rows.push({ source, text, status: 'dropped', note: 'Not read: this client designs from its packaged reference (kaae-reference.json), not its DNA row. Say it as a standing rule, or promote it from the candidate list, for it to reach the next design.' });
  }
  // A promotion whose words are no longer in the DNA (the DNA was edited by hand) still reaches a
  // packaged client's designs, from its record.
  for (const r of learned) {
    if (layoutRules.includes(r.humanRule)) continue;
    rows.push({ source: 'learned_rule', text: r.humanRule, status: reference === 'packaged' ? 'prompt_only' : 'dropped',
      note: reference === 'packaged' ? PACKAGED_NOTE : 'Promoted, but its words are no longer in the active DNA, which is what this client\'s designs read.' });
  }

  if (d) {
    const dnaPalette = [...new Set((Array.isArray(d.colors) ? d.colors : []).map((c: any) => String(c?.hex || '').toUpperCase()).filter((h: string) => /^#[0-9A-F]{6}$/.test(h)))] as string[];
    const logo = Array.isArray(d.assets) ? d.assets.find((a: any) => a?.role === 'logo_primary') : undefined;
    const dnaLogoMin = Number.isInteger(logo?.minimumWidthPx) ? Number(logo.minimumWidthPx) : undefined;
    const brand = (kind: RuleEffectRow['kind'], text: string, same: boolean | undefined) => {
      if (reference === 'client_dna') {
        rows.push({ source: 'dna_brand_value', kind, text, status: 'applied_deterministically',
          note: kind === 'palette' ? 'Preparation snaps every colour to it and hard QA checks it.' : 'The composer and hard QA keep the logo at least this wide (and at least the house minimum).' });
      } else if (same) {
        rows.push({ source: 'dna_brand_value', kind, text, status: 'applied_deterministically', note: 'The packaged reference this client designs from has the same value, which code enforces.' });
      } else {
        rows.push({ source: 'dna_brand_value', kind, text, status: 'dropped', note: 'Not read: the packaged reference this client designs from has a different value, and that one is enforced.' });
      }
    };
    if (dnaPalette.length) {
      const packagedPalette = new Set(((packaged?.rules?.palette as string[] | undefined) ?? []).map((h) => h.toUpperCase()));
      brand('palette', dnaPalette.join(' '), packaged ? dnaPalette.length === packagedPalette.size && dnaPalette.every((h) => packagedPalette.has(h)) : undefined);
    }
    if (dnaLogoMin !== undefined) {
      brand('logo_minimum_width', `Logo at least ${dnaLogoMin}px wide`, packaged ? Number(packaged.rules?.logoConstraints?.minimumWidthPx) === dnaLogoMin : undefined);
    }
  }

  const counts: Record<RuleEffectStatus, number> = { applied_deterministically: 0, prompt_only: 0, dropped: 0 };
  for (const r of rows) counts[r.status]++;
  return { clientId, reference, rules: rows, counts };
}

async function packagedReferenceFor(clientId: string): Promise<Record<string, any> | undefined> {
  const path = creativeAssetPath('kaae-reference.json', { optional: true });
  if (!path) return undefined;
  const reference = JSON.parse(await readFile(path, 'utf8'));
  return reference?.clientId === clientId ? reference : undefined;
}
