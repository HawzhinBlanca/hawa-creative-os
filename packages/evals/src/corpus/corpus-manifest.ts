import { createHash } from 'node:crypto';

export type CorpusSplit = 'development' | 'calibration' | 'final_holdout';
export type CorpusLanguage = 'en' | 'ckb' | 'ar' | 'mixed';

/** A private, authorized source record. Text and assets are hashed by the caller. */
export interface CorpusCandidate {
  caseId: string;
  clientId: string;
  campaignId: string;
  requestLineageId: string;
  derivativeOf?: string;
  language: CorpusLanguage;
  format: string;
  taskClass: string;
  sourceKind: 'historical' | 'reconstructed';
  reconstructionBasis?: string;
  sourceRecordedAt: string;
  evaluationApprovedBy: string;
  evaluationApprovedAt: string;
  approvalEvidenceSha256: string;
  previouslyUsedForTuning: boolean;
  briefSha256: string;
  assetSha256: string[];
  /** Kept in memory only for duplicate detection; never emitted in the manifest. */
  normalizedBrief: string;
}

export interface CorpusManifest {
  schemaVersion: 1;
  status: 'inventory_only' | 'machine_sealed_pending_review';
  seedSha256: string;
  counts: { total: number; clients: number; bySplit: Record<CorpusSplit, number>; byLanguage: Record<CorpusLanguage, number> };
  cases: Array<Omit<CorpusCandidate, 'normalizedBrief'> & { split: CorpusSplit; duplicateGroup: string }>;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const hashPattern = /^[0-9a-f]{64}$/;

function shingles(text: string): Set<string> {
  const compact = text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/g, ' ').trim();
  if (compact.length <= 5) return new Set([compact]);
  const result = new Set<string>();
  for (let i = 0; i <= compact.length - 5; i++) result.add(compact.slice(i, i + 5));
  return result;
}

function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection) >= 0.88;
}

/** Campaign, request, derivative, exact and near-duplicate records stay in one split. */
export function buildCorpusManifest(candidates: CorpusCandidate[], seed: string, seal = false): CorpusManifest {
  if (!/^[0-9a-f]{32,128}$/i.test(seed)) throw new Error('A predeclared hexadecimal split seed is required');
  if (candidates.length === 0) throw new Error('No corpus candidates supplied');
  const ids = new Map<string, number>();
  candidates.forEach((c, i) => {
    if (!c.caseId || ids.has(c.caseId)) throw new Error(`Missing or duplicate caseId: ${c.caseId}`);
    ids.set(c.caseId, i);
    for (const field of ['clientId', 'campaignId', 'requestLineageId', 'format', 'taskClass', 'sourceRecordedAt', 'evaluationApprovedBy', 'evaluationApprovedAt'] as const) {
      if (!c[field] || typeof c[field] !== 'string') throw new Error(`${c.caseId}: ${field} is required`);
    }
    if (!['en', 'ckb', 'ar', 'mixed'].includes(c.language)) throw new Error(`${c.caseId}: unsupported language`);
    if (!['historical', 'reconstructed'].includes(c.sourceKind)) throw new Error(`${c.caseId}: invalid source kind`);
    if (c.sourceKind === 'reconstructed' && !c.reconstructionBasis) throw new Error(`${c.caseId}: reconstruction basis required`);
    if (!Number.isFinite(Date.parse(c.sourceRecordedAt))) throw new Error(`${c.caseId}: invalid source date`);
    if (!Number.isFinite(Date.parse(c.evaluationApprovedAt))) throw new Error(`${c.caseId}: invalid approval date`);
    if (Date.parse(c.evaluationApprovedAt) < Date.parse(c.sourceRecordedAt)) throw new Error(`${c.caseId}: evaluation approval predates source`);
    if (!hashPattern.test(c.approvalEvidenceSha256) || !hashPattern.test(c.briefSha256) || !Array.isArray(c.assetSha256) || c.assetSha256.some((h) => !hashPattern.test(h))) {
      throw new Error(`${c.caseId}: source hashes required`);
    }
    if (!c.normalizedBrief?.trim()) throw new Error(`${c.caseId}: empty brief`);
  });

  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number): void => { parent[find(b)] = find(a); };
  const seen = new Map<string, number>();
  candidates.forEach((c, i) => {
    for (const key of [
      `campaign:${c.clientId}:${c.campaignId}`,
      `request:${c.clientId}:${c.requestLineageId}`,
      `brief:${c.briefSha256}`,
      `normalized:${sha(c.normalizedBrief.normalize('NFKC').replace(/\s+/g, ' ').trim())}`,
    ]) {
      const previous = seen.get(key);
      if (previous !== undefined) union(i, previous);
      else seen.set(key, i);
    }
    if (c.derivativeOf) {
      const parentIndex = ids.get(c.derivativeOf);
      if (parentIndex === undefined) throw new Error(`${c.caseId}: derivative parent is missing from corpus`);
      union(i, parentIndex);
    }
  });
  const grams = candidates.map((c) => shingles(c.normalizedBrief));
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (find(i) !== find(j) && nearDuplicate(grams[i], grams[j])) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  candidates.forEach((_, i) => { const root = find(i); groups.set(root, [...(groups.get(root) || []), i]); });
  const groupList = [...groups.values()].map((indices) => ({
    indices,
    id: sha(indices.map((i) => candidates[i].caseId).sort().join('\n')),
    forcedDevelopment: indices.some((i) => candidates[i].previouslyUsedForTuning),
  })).sort((a, b) => sha(seed + a.id).localeCompare(sha(seed + b.id)));

  const count: Record<CorpusSplit, number> = { development: 0, calibration: 0, final_holdout: 0 };
  const assigned = new Map<number, { split: CorpusSplit; group: string }>();
  const targets = { development: Math.floor(candidates.length * 0.4), calibration: Math.floor(candidates.length * 0.1), final_holdout: candidates.length - Math.floor(candidates.length * 0.4) - Math.floor(candidates.length * 0.1) };
  for (const group of groupList) {
    const split: CorpusSplit = group.forcedDevelopment ? 'development' :
      (['final_holdout', 'development', 'calibration'] as CorpusSplit[])
        .sort((a, b) => (targets[b] - count[b]) - (targets[a] - count[a]))[0];
    count[split] += group.indices.length;
    for (const i of group.indices) assigned.set(i, { split, group: group.id });
  }

  const clients = new Set(candidates.map((c) => c.clientId)).size;
  const languages: Record<CorpusLanguage, number> = { en: 0, ckb: 0, ar: 0, mixed: 0 };
  candidates.forEach((c) => languages[c.language]++);
  if (seal && (candidates.length < 200 || clients < 3 || count.development < 80 || count.calibration < 20 || count.final_holdout < 100)) {
    throw new Error('Final seal requires at least 200 authorized cases, three clients, and 80/20/100 development/calibration/holdout cases');
  }
  const cases = candidates.map((c, i) => {
    const { normalizedBrief: _privateText, ...safe } = c;
    return { ...safe, split: assigned.get(i)!.split, duplicateGroup: assigned.get(i)!.group };
  }).sort((a, b) => a.caseId.localeCompare(b.caseId));
  return { schemaVersion: 1, status: seal ? 'machine_sealed_pending_review' : 'inventory_only', seedSha256: sha(seed),
    counts: { total: candidates.length, clients, bySplit: count, byLanguage: languages }, cases };
}
