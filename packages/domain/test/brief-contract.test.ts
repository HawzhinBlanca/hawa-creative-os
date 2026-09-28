import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BRIEF_CONTRACT_VERSION,
  BRIEF_CONTRACT_CHOICES,
  LAYOUT_RELATION_KINDS,
  buildBriefContract,
  validateBriefContract,
  verifyBriefContractIntegrity,
  blockingBriefConflicts,
  renderBriefContractForPrompt,
  canonicalJson,
  briefContractIdentitySha256,
  type BriefContractInput,
} from '../src/brief-contract.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const policy = { id: 'studio.negative-space', version: '2026-09-28.1', sha256: 'a'.repeat(64) };

function input(overrides: Partial<BriefContractInput> = {}): BriefContractInput {
  return {
    canvas: { width: 1080, height: 1350 },
    copy: [{ text: 'Workshop on quality assurance', script: 'latin' }, { text: 'ڕێکەوتی ١٢ی تشرین', script: 'arabic' }],
    copyAuthority: 'source_copy',
    instructions: 'Use the supplied wording exactly. Navy background.',
    clientRules: '1. Logo top right.',
    logo: { sha256: 'b'.repeat(64) },
    photos: [{ sha256: 'c'.repeat(64), width: 800, height: 1000 }],
    reference: null,
    brief: {
      occasion: 'Workshop', audience: 'Staff', formality: 3, toneWords: ['calm', 'clear', 'formal'],
      readingOrder: [1, 0], roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'date', importance: 3 }],
      must: ['Logo top right'], mustNot: ['No clip art'], imageryStrategy: 'none', imageryRationale: 'Typography only',
      kurdishLeads: false, riskFlags: ['Venue not stated'], requestedBackground: '#123456',
      imageRoles: [{ index: 0, role: 'content_photo', notes: 'Speaker' }, { index: 1, role: 'unrelated', notes: '' }],
      styleSpec: { logoCorner: 'top-right', typeface: 'serif', titleScale: 'as_generated' },
    },
    appliedBackground: '#0A1628',
    policies: [policy],
    ...overrides,
  };
}

describe('executable brief contract (ADR-125)', () => {
  it('binds exact content to source identities, not to a model summary', () => {
    const contract = buildBriefContract(input());
    expect(contract.version).toBe(BRIEF_CONTRACT_VERSION);
    expect(contract.elements.map((e) => e.id)).toEqual(['canvas', 'canvas.safe-area', 'text-copy-0', 'text-copy-1', 'logo', 'photo-0']);
    const copy = contract.items.filter((i) => i.layer === 'exact_content' && i.subject[0].startsWith('text-copy-'));
    expect(copy).toEqual([
      expect.objectContaining({ id: 'content/text-copy-0', authority: 'source_copy', value: { sha256: sha('Workshop on quality assurance'), characters: 29, script: 'latin' } }),
      expect.objectContaining({ id: 'content/text-copy-1', authority: 'source_copy', value: expect.objectContaining({ sha256: sha('ڕێکەوتی ١٢ی تشرین') }) }),
    ]);
    // The contract carries hashes; the one copy authority stays the request.
    expect(JSON.stringify(contract)).not.toContain('Workshop on quality assurance');
    expect(contract.items.find((i) => i.id === 'content/logo')).toMatchObject({ authority: 'client_asset', value: { sha256: 'b'.repeat(64) } });
    expect(contract.items.find((i) => i.id === 'content/photo-0')).toMatchObject({ authority: 'client_asset', layer: 'exact_content' });
    expect(buildBriefContract(input({ copyAuthority: 'run_effective_copy' })).items.find((i) => i.id === 'content/text-copy-0')?.authority).toBe('run_effective_copy');
  });

  it('keeps source-copy order protected and the model reading order a proposal', () => {
    const contract = buildBriefContract(input());
    expect(contract.items.find((i) => i.id === 'relation/reading-order/source')).toMatchObject({
      layer: 'protected_design', authority: 'source_copy', relation: 'readingOrder', subject: ['text-copy-0', 'text-copy-1'], enforcedBy: ['COPY_ORDER'],
    });
    expect(contract.items.find((i) => i.id === 'proposal/reading-order')).toMatchObject({
      layer: 'communication_intent', authority: 'model_proposal', relation: 'readingOrder', subject: ['text-copy-1', 'text-copy-0'], adopted: false,
    });
    expect(contract.conflicts.find((c) => c.code === 'READING_ORDER_PROPOSAL_NOT_ADOPTED')).toMatchObject({ blocking: false, resolution: 'source_copy_order_protected' });
    const same = buildBriefContract(input({ brief: { ...input().brief, readingOrder: [0, 1] } }));
    expect(same.conflicts.some((c) => c.code === 'READING_ORDER_PROPOSAL_NOT_ADOPTED')).toBe(false);
    expect(same.items.find((i) => i.id === 'proposal/reading-order')?.adopted).toBe(true);
  });

  it('never promotes a model proposal to exact content or protected design', () => {
    const contract = buildBriefContract(input());
    expect(validateBriefContract(contract)).toEqual([]);
    for (const item of contract.items.filter((i) => i.authority === 'model_proposal')) {
      expect(['communication_intent', 'soft_preference', 'unknown']).toContain(item.layer);
    }
    expect(contract.items.find((i) => i.id === 'proposal/must')).toMatchObject({ layer: 'soft_preference', authority: 'model_proposal', value: ['Logo top right'] });
    expect(contract.items.find((i) => i.id === 'proposal/style/logoCorner')).toMatchObject({ layer: 'soft_preference', relation: 'anchor', subject: ['logo'], value: 'top-right', enforcedBy: ['preparation'] });
    expect(contract.items.some((i) => i.id === 'proposal/style/titleScale')).toBe(false);
    expect(contract.items.find((i) => i.id === 'rule/client')).toMatchObject({ layer: 'protected_design', authority: 'client_rule', value: { sha256: sha('1. Logo top right.') } });
    const forged = { ...contract, items: contract.items.map((i) => (i.id === 'proposal/must' ? { ...i, layer: 'protected_design' as const } : i)) };
    expect(validateBriefContract(forged)).toContain('MODEL_PROPOSAL_PROMOTED:proposal/must');
    const duplicate = { ...contract, items: [...contract.items, contract.items[0]] };
    expect(validateBriefContract(duplicate)).toContain(`DUPLICATE_FACT:${contract.items[0].id}`);
    const dangling = { ...contract, items: [...contract.items, { ...contract.items[0], id: 'relation/x', relation: 'group' as const, subject: ['text-copy-9'] }] };
    expect(validateBriefContract(dangling)).toContain('UNKNOWN_ELEMENT:relation/x:text-copy-9');
  });

  it('uses the layout relationship vocabulary with stable element IDs', () => {
    const contract = buildBriefContract(input());
    expect([...LAYOUT_RELATION_KINDS]).toEqual(['align', 'group', 'readingOrder', 'gap', 'keepInside', 'anchor', 'aspect', 'crop', 'noOverlap']);
    const relations = contract.items.filter((i) => i.relation);
    for (const r of relations) expect(LAYOUT_RELATION_KINDS).toContain(r.relation);
    expect(contract.items.find((i) => i.id === 'relation/keep-inside/safe-area')).toMatchObject({
      layer: 'protected_design', authority: 'house_policy', relation: 'keepInside', subject: ['text-copy-0', 'text-copy-1', 'logo', 'canvas.safe-area'], enforcedBy: ['BOUNDS'],
    });
    expect(contract.items.find((i) => i.id === 'relation/no-overlap/text-logo')).toMatchObject({ relation: 'noOverlap', enforcedBy: ['OVERLAP'] });
    expect(contract.items.find((i) => i.id === 'relation/no-overlap/photos')).toMatchObject({ relation: 'noOverlap', subject: ['photo-0', 'text-copy-0', 'text-copy-1', 'logo'], enforcedBy: ['PHOTOS'] });
    expect(contract.items.find((i) => i.id === 'relation/aspect/logo')).toMatchObject({ relation: 'aspect', subject: ['logo'], enforcedBy: ['LOGO'] });
    expect(contract.items.find((i) => i.id === 'change/crop/photo-0')).toMatchObject({ layer: 'permitted_change', relation: 'crop', subject: ['photo-0'] });
    // Same input, same identities: IDs do not depend on the model's role labels.
    const relabelled = buildBriefContract(input({ brief: { ...input().brief, roles: [{ copyIndex: 0, role: 'body', importance: 1 }, { copyIndex: 1, role: 'title', importance: 5 }] } }));
    expect(relabelled.elements.map((e) => e.id)).toEqual(contract.elements.map((e) => e.id));
  });

  it('surfaces disagreements with their authority resolution instead of resolving them silently', () => {
    const contract = buildBriefContract(input());
    expect(contract.conflicts.find((c) => c.code === 'IMAGERY_NONE_WITH_CLIENT_PHOTOS')).toMatchObject({
      blocking: false, subject: ['photo-0'], resolution: 'client_photos_retained_optional_art_suppressed',
    });
    expect(contract.conflicts.find((c) => c.code === 'REQUESTED_BACKGROUND_MAPPED_TO_PALETTE')).toMatchObject({
      blocking: false, resolution: 'nearest_palette_colour', authorizedChoices: ['ACCEPT_PALETTE_COLOUR', 'AUTHORIZED_PALETTE_CHANGE'],
    });
    expect(contract.items.filter((i) => i.layer === 'unknown').map((i) => i.id)).toEqual(['unknown/risk/0', 'unknown/image/1']);
    expect(blockingBriefConflicts(contract)).toEqual([]);
    const matching = buildBriefContract(input({ appliedBackground: '#123456', photos: [] }));
    expect(matching.conflicts.map((c) => c.code)).toEqual(['READING_ORDER_PROPOSAL_NOT_ADOPTED']);
  });

  it('returns a small explanation and only authorized choices for copy that cannot be set', () => {
    const contract = buildBriefContract(input({ copyFeasibility: { version: 'copy-feasibility.v1', safeWidthPx: 952, minimumFontPx: 12, blocks: [
      { copyIndex: 0, status: 'fits', narrowestPx: 180, measuredFaces: 26, unmeasured: [] },
      { copyIndex: 1, status: 'exceeds_safe_width', narrowestPx: 1301, family: 'Amiri', measuredFaces: 4, unmeasured: [] },
    ] } }));
    const [conflict] = blockingBriefConflicts(contract);
    expect(conflict).toMatchObject({ code: 'COPY_UNBREAKABLE_AT_MINIMUM_SIZE', blocking: true, subject: ['text-copy-1'],
      authorizedChoices: ['CLIENT_APPROVES_REVISED_COPY', 'CHOOSE_WIDER_APPROVED_FORMAT'] });
    for (const choice of conflict.authorizedChoices) expect(BRIEF_CONTRACT_CHOICES).toContain(choice);
    expect(conflict.explanation).toContain('1301px');
    expect(conflict.explanation).toContain('952px');
    expect(conflict.explanation).toMatch(/not shrunk, omitted, split or reworded/);
    expect(conflict.explanation.length).toBeLessThan(400);
    const unknown = buildBriefContract(input({ copyFeasibility: { version: 'copy-feasibility.v1', safeWidthPx: 952, minimumFontPx: 12, blocks: [
      { copyIndex: 1, status: 'unknown', measuredFaces: 0, unmeasured: ['Amiri:FONT_UNAVAILABLE'] },
    ] } }));
    expect(blockingBriefConflicts(unknown)).toEqual([]);
    expect(unknown.items.find((i) => i.id === 'unknown/fit/text-copy-1')).toMatchObject({ layer: 'unknown', authority: 'house_policy' });
  });

  it('is deterministic, hash-bound and records the policies it was built under', () => {
    const a = buildBriefContract(input());
    const b = buildBriefContract(input());
    expect(a.sha256).toBe(b.sha256);
    expect(verifyBriefContractIntegrity(a)).toBe(true);
    expect(a.policies).toEqual([policy]);
    // Canonical JSON: the digest must survive PostgreSQL JSONB key reordering.
    expect(a.briefSha256).toBe(sha(canonicalJson(input().brief)));
    const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(a) as typeof a;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(a));
    expect(verifyBriefContractIntegrity(reordered)).toBe(true);
    const changed = buildBriefContract(input({ copy: [{ text: 'Workshop on quality assurance.', script: 'latin' }, input().copy[1]] }));
    expect(changed.sha256).not.toBe(a.sha256);
    expect(verifyBriefContractIntegrity({ ...a, policies: [{ ...policy, version: '2026-09-29.1' }] })).toBe(false);
  });

  it('separates the run authorities from evidence that depends on fonts, measurer and policy versions', () => {
    const fit = (status: 'fits' | 'exceeds_safe_width' | 'unknown', narrowestPx?: number) => ({ version: 'copy-feasibility.v1', safeWidthPx: 952, minimumFontPx: 12,
      blocks: [{ copyIndex: 1, status, ...(narrowestPx ? { narrowestPx, family: 'Amiri' } : {}), measuredFaces: status === 'unknown' ? 0 : 4,
        unmeasured: status === 'unknown' ? ['Amiri:FONT_UNAVAILABLE'] : [] }] });
    const recorded = buildBriefContract(input({ copyFeasibility: fit('fits', 400) }));
    const identity = briefContractIdentitySha256(recorded);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    // A new policy version, a font that is now unmeasurable, or a measurer that now finds an
    // unbreakable run changes the evidence (and the full digest) but not whose facts these are.
    for (const env of [
      input({ copyFeasibility: fit('fits', 400), policies: [{ ...policy, version: '2026-09-28.2', sha256: 'd'.repeat(64) }] }),
      input({ copyFeasibility: fit('unknown') }),
      input({ copyFeasibility: fit('exceeds_safe_width', 1301) }),
    ]) {
      const rebuilt = buildBriefContract(env);
      expect(rebuilt.sha256).not.toBe(recorded.sha256);
      expect(briefContractIdentitySha256(rebuilt)).toBe(identity);
    }
    // A change of any authority is a different contract.
    for (const changed of [
      input({ copyFeasibility: fit('fits', 400), copy: [input().copy[0], { text: 'ڕێکەوتی ١٣ی تشرین', script: 'arabic' }] }),
      input({ copyFeasibility: fit('fits', 400), copyAuthority: 'run_effective_copy' }),
      input({ copyFeasibility: fit('fits', 400), logo: { sha256: 'e'.repeat(64) } }),
      input({ copyFeasibility: fit('fits', 400), clientRules: '1. Logo top left.' }),
      input({ copyFeasibility: fit('fits', 400), brief: { ...input().brief, readingOrder: [0, 1] } }),
    ]) expect(briefContractIdentitySha256(buildBriefContract(changed))).not.toBe(identity);
  });

  it('builds from a legacy partial brief without inventing proposals', () => {
    const contract = buildBriefContract(input({ brief: { imageryStrategy: 'none' }, photos: [], logo: null, clientRules: '', instructions: '' }));
    expect(validateBriefContract(contract)).toEqual([]);
    expect(contract.items.some((i) => i.id === 'proposal/reading-order')).toBe(false);
    expect(contract.items.some((i) => i.id === 'proposal/must')).toBe(false);
    expect(contract.items.some((i) => i.id === 'rule/client')).toBe(false);
    expect(contract.elements.map((e) => e.id)).toEqual(['canvas', 'canvas.safe-area', 'text-copy-0', 'text-copy-1']);
  });

  it('renders a compact prompt section that states authority per layer', () => {
    const text = renderBriefContractForPrompt(buildBriefContract(input()));
    expect(text).toContain(BRIEF_CONTRACT_VERSION);
    expect(text).toContain('readingOrder text-copy-0 > text-copy-1 (source copy order; protected)');
    expect(text).toContain('Model proposals are advisory');
    expect(text).toContain('proposed reading order text-copy-1 > text-copy-0 (not adopted)');
    expect(text).toContain('IMAGERY_NONE_WITH_CLIENT_PHOTOS');
    expect(text).not.toContain('Workshop on quality assurance');
    expect(text.length).toBeLessThan(2400);
  });
});
