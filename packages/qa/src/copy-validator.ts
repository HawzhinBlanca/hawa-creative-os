import type { QAFinding } from '@hawa/contracts';
import type { ExactCopyBlock } from '@hawa/domain';

export function normalizeForComparison(text: string): string {
  if (!text) return '';
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Consume whole approved blocks, longest first: a headline repeated inside an
// approved paragraph is not an extra headline. Text may wrap across live nodes.
function consumeApproved(texts: string[], blocks: ExactCopyBlock[]) {
  let remaining = (texts || []).map(normalizeForComparison).join(' ');
  const missing: ExactCopyBlock[] = [];
  const ordered = [...(blocks || [])].sort((a, b) => (b.text || '').length - (a.text || '').length);
  for (const block of ordered) {
    const target = normalizeForComparison(block?.text || '');
    if (!target) continue;
    const index = findBlock(remaining, target);
    if (index < 0) missing.push(block);
    else remaining = remaining.slice(0, index) + ' ' + remaining.slice(index + target.length);
  }
  return { remaining, missing };
}

function findBlock(text: string, target: string): number {
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(target, from);
    if (i < 0) return -1;
    if ((i === 0 || /\s/.test(text[i - 1])) &&
        (i + target.length === text.length || /\s/.test(text[i + target.length]))) return i;
    from = i + 1;
  }
  return -1;
}

export function validateExactCopy(blocks: ExactCopyBlock[], texts: string[]): QAFinding[] {
  const { remaining, missing } = consumeApproved(texts, blocks);
  const findings: QAFinding[] = missing.map(block => ({
    ruleId: 'EXACT_COPY_MISSING', severity: 'critical', hardFailure: true, category: 'copy',
    message: `Approved copy block is missing or changed: ${block.text}`, nodeIds: [],
    evidence: { approvedCopy: block.text, role: block.role },
  }));
  for (const block of blocks) {
    const target = normalizeForComparison(block.text);
    if (target && findBlock(remaining, target) >= 0) findings.push({
      ruleId: 'DUPLICATE_COPY_DETECTED', severity: 'critical', hardFailure: true, category: 'copy',
      message: 'Approved copy occurs more often than authorized', nodeIds: [],
      evidence: { approvedCopy: block.text },
    });
    for (const token of block.protectedTokens || []) {
      if (!texts.map(normalizeForComparison).join(' ').includes(normalizeForComparison(token.raw))) findings.push({
        ruleId: 'PROTECTED_TOKEN_MUTATED', severity: 'critical', hardFailure: true, category: 'copy',
        message: `Protected token is missing or changed: ${token.raw}`, nodeIds: [],
        evidence: { token: token.raw, type: token.type },
      });
    }
  }
  return findings;
}

export function detectUnsolicitedContent(
  texts: string[], blocks: ExactCopyBlock[], allowedBrandPhrases: string[] = []
): QAFinding[] {
  let { remaining } = consumeApproved(texts, blocks);
  for (const phrase of [...allowedBrandPhrases].sort((a, b) => b.length - a.length)) {
    const target = normalizeForComparison(phrase);
    if (!target) continue;
    const index = findBlock(remaining, target);
    if (index >= 0) remaining = remaining.slice(0, index) + ' ' + remaining.slice(index + target.length);
  }
  remaining = normalizeForComparison(remaining);
  return remaining ? [{
    ruleId: 'UNSOLICITED_CONTENT_DETECTED', severity: 'critical', hardFailure: true, category: 'copy',
    message: 'Design contains text absent from approved copy and approved brand phrases', nodeIds: [],
    evidence: { offendingText: remaining },
  }] : [];
}
