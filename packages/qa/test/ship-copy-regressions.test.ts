import { describe, it, expect } from 'vitest';
import { validateExactCopy, detectUnsolicitedContent } from '../src/copy-validator.js';
import { DeterministicQAEngine } from '../src/engine.js';
import type { ExactCopyBlock } from '@hawa/domain';
import type { QARequest } from '@hawa/contracts';
const copy = (text: string): ExactCopyBlock => ({ id: text, role: 'body', text, language: 'en', direction: 'ltr', approved: true, protectedTokens: [] });

describe('FR-014/015/027: bidirectional copy and visible logo proof', () => {
  it.each(['Dinner starts at 6 PM.', 'KURDISTAN REGIONAL GOVERNMENT · PROTOCOL OFFICE · ERBIL', 'By Invitation Only Dinner is included.'])('rejects unfamiliar unapproved text: %s', extra => {
    expect(detectUnsolicitedContent(['By Invitation Only', extra], [copy('By Invitation Only')]).some(f => f.hardFailure)).toBe(true);
  });
  it('no approved copy does not mean any copy is authorized', () => expect(detectUnsolicitedContent(['Made up'], [])).not.toEqual([]));
  it('permits wrapped nodes and normalized whitespace without rewriting the copy', () => {
    const nodes = ['This invitation is personal', 'and non-transferable.'];
    const approved = [copy('This invitation is personal\nand non-transferable.')];
    expect(validateExactCopy(approved, nodes)).toEqual([]);
    expect(detectUnsolicitedContent(nodes, approved)).toEqual([]);
  });
  it('counts duplicate text in one node', () => {
    expect(validateExactCopy([copy('By Invitation Only')], ['By Invitation Only By Invitation Only']).some(f => f.ruleId === 'DUPLICATE_COPY_DETECTED')).toBe(true);
  });
  it('does not confuse a heading quoted inside separately approved body with a duplicate', () => {
    const approved = [copy('National Standards'), copy('The National Standards will be announced.')];
    expect(validateExactCopy(approved, approved.map(x => x.text))).toEqual([]);
    expect(detectUnsolicitedContent(approved.map(x => x.text), approved)).toEqual([]);
  });
  it('a brand phrase permits only that phrase, not extra invented facts', () => {
    expect(detectUnsolicitedContent(['Brand Name Dinner at 6 PM.'], [], ['Brand Name'])).not.toEqual([]);
    expect(detectUnsolicitedContent(['Brand Name'], [], ['Brand Name'])).toEqual([]);
  });
  const request = (): QARequest => ({ taskId: 't', designRevisionId: 'r', document: { documentId: 'd', sourceRevision: 1, sourceSha256: 'hash', studio: 'Canva', studioVersion: '1', schemaVersion: '1' }, sourceHash: 'hash',
    manifest: { pages: [{ id: 'p', name: 'P', width: 1080, height: 1350, unit: 'px' }], nodes: [], fonts: [], assets: [{ sha256: 'approved-logo', mimeType: 'image/png', sourceId: 'logo_primary' }], warnings: [] },
    renders: [], brief: { requiredAssetRoles: ['logo_primary'], exactCopy: [] }, clientDna: { assets: [{ role: 'logo_primary', sha256: 'approved-logo' }] }, profile: { name: 'strict', version: '1', rules: {} }, repairCycle: 0 });
  it('an asset entry without a visible logo cannot pass', async () => {
    const result = await new DeterministicQAEngine().run({ tenantId: 'tenant', actor: { type: 'user', id: 'u' }, correlationId: 'c', deadline: '2099', idempotencyKey: 'k' }, request());
    expect(result.ok && result.value.findings.some(f => f.ruleId === 'OFFICIAL_LOGO_MISSING_OR_MUTATED')).toBe(true);
  });
  it('the manifest cannot self-authorize a substituted logo', async () => {
    const r = request(); r.manifest.nodes.push({ id: 'logo', type: 'image', pageId: 'p', assetSha256: 'rogue', locked: true, zIndex: 1 });
    r.manifest.assets[0].sha256 = 'rogue';
    const result = await new DeterministicQAEngine().run({ tenantId: 'tenant', actor: { type: 'user', id: 'u' }, correlationId: 'c', deadline: '2099', idempotencyKey: 'k' }, r);
    expect(result.ok && result.value.findings.some(f => f.ruleId === 'OFFICIAL_LOGO_MISSING_OR_MUTATED')).toBe(true);
  });
});
