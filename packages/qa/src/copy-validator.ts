import type { QAFinding } from '@hawa/contracts';
import type { ExactCopyBlock, ProtectedToken } from '@hawa/domain';

export function normalizeForComparison(text: string): string {
  // Normalize Unicode NFC and collapse consecutive whitespace for comparison, preserving characters
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function validateExactCopy(
  approvedCopyBlocks: ExactCopyBlock[],
  extractedDocumentTexts: string[]
): QAFinding[] {
  const findings: QAFinding[] = [];
  const joinedDocText = extractedDocumentTexts.map(normalizeForComparison).join(' ');

  for (const block of approvedCopyBlocks) {
    const normalizedTarget = normalizeForComparison(block.text);
    const found = extractedDocumentTexts.some((docText) => normalizeForComparison(docText).includes(normalizedTarget));

    if (!found) {
      findings.push({
        ruleId: 'EXACT_COPY_MISSING',
        severity: 'critical',
        hardFailure: true,
        category: 'copy',
        message: `Approved copy block "${block.text}" (role: ${block.role}) is missing from design canvas`,
        nodeIds: [],
        evidence: {
          approvedCopy: block.text,
          extractedTexts: extractedDocumentTexts,
        },
      });
    }

    // Check all protected tokens in block
    for (const token of block.protectedTokens) {
      const tokenFound = joinedDocText.includes(normalizeForComparison(token.raw));
      if (!tokenFound) {
        findings.push({
          ruleId: 'PROTECTED_TOKEN_MUTATED',
          severity: 'critical',
          hardFailure: true,
          category: 'copy',
          message: `Protected token "${token.raw}" (type: ${token.type}) was mutated or omitted in canvas text`,
          nodeIds: [],
          evidence: {
            token: token.raw,
            type: token.type,
          },
        });
      }
    }
  }

  return findings;
}
