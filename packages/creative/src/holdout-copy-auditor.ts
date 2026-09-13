import type { Result, AppError } from '@hawa/contracts';
import {
  type DesignBrief,
  type ExactCopyBlock,
  type ProtectedToken,
  extractProtectedTokens,
} from '@hawa/domain';

export interface AuditCandidateInput {
  candidateText?: string;
  copyBlocks?: ExactCopyBlock[];
  operations?: Array<{ op: string; text?: string; role?: string }>;
}

export interface AuditSuccess {
  auditedTokensCount: number;
  preservedTokens: ProtectedToken[];
  preservedBlocksCount: number;
  exactMatch: boolean;
  normalizedText: string;
}

export class HoldoutCopyAuditor {
  /**
   * Normalizes text for collation-aware comparison (collapsing whitespace, normalizing digits and Kurdish/Arabic diacritics).
   */
  normalizeText(text: string): string {
    return text
      .trim()
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width characters
      .replace(/\s+/g, ' ')
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Normalize Eastern Arabic numerals
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0)) // Normalize Persian/Kurdish numerals
      .replace(/[\u064B-\u065F\u0670]/g, ''); // Remove tashkeel/harakat for comparison tolerance
  }

  /**
   * Extracts combined text representation from various candidate input structures.
   */
  extractText(input: AuditCandidateInput | string): string {
    if (typeof input === 'string') {
      return input;
    }
    if (input.candidateText) {
      return input.candidateText;
    }
    if (input.copyBlocks && input.copyBlocks.length > 0) {
      return input.copyBlocks.map((b) => b.text).join(' ');
    }
    if (input.operations && input.operations.length > 0) {
      return input.operations
        .filter(
          (op) =>
            (op.op === 'addText' || op.op === 'replaceText' || op.op === 'replace_text') &&
            typeof op.text === 'string'
        )
        .map((op) => op.text!)
        .join(' ');
    }
    return '';
  }

  /**
   * Evaluates candidate copy against the authoritative brief.
   * Rejects with structured errors if protected tokens are mutated, dropped, or unapproved slogans are invented (FR-014, FR-015).
   */
  auditCandidateCopy(
    brief: DesignBrief,
    candidate: AuditCandidateInput | string
  ): Result<AuditSuccess, AppError> {
    const rawCandidateText = this.extractText(candidate);
    const normalizedCandidate = this.normalizeText(rawCandidateText);

    if (!normalizedCandidate) {
      return {
        ok: false,
        error: {
          code: 'EMPTY_CANDIDATE_COPY',
          message: 'Candidate copy is completely empty; cannot qualify design.',
          retryable: false,
          safeAction: 'Provide non-empty candidate layout with live text nodes',
        },
      };
    }

    // 1. Gather all protected tokens from brief exactCopy blocks
    const expectedTokens: ProtectedToken[] = [];
    for (const block of brief.exactCopy || []) {
      if (block.protectedTokens && block.protectedTokens.length > 0) {
        expectedTokens.push(...block.protectedTokens);
      } else {
        // Dynamically extract if not pre-populated
        expectedTokens.push(...extractProtectedTokens(block.text));
      }
    }

    // 2. Verify all protected tokens exist unaltered in the candidate text
    for (const token of expectedTokens) {
      const normalizedToken = this.normalizeText(token.raw);
      if (!normalizedCandidate.includes(normalizedToken)) {
        return {
          ok: false,
          error: {
            code: 'PROTECTED_TOKEN_MUTATED',
            message: `Factual holdout control failed: Protected token '${token.raw}' (${token.type}) was mutated or omitted in candidate text.`,
            retryable: true,
            safeAction: 'Re-inject original protected token into typography zone without modification',
            detail: {
              tokenType: token.type,
              expectedRaw: token.raw,
              normalizedExpected: normalizedToken,
              candidateTextSnippet: normalizedCandidate.substring(0, 150),
            },
          },
        };
      }
    }

    // 3. Verify mandatory disclaimers and legal copy blocks
    const disclaimerBlocks = (brief.exactCopy || []).filter(
      (b) => b.role === 'disclaimer' || b.text.includes('یاسای ژمارە') || b.text.includes('دەرمان ناگرێتەوە')
    );

    for (const discl of disclaimerBlocks) {
      const normalizedDiscl = this.normalizeText(discl.text);
      if (!normalizedCandidate.includes(normalizedDiscl)) {
        return {
          ok: false,
          error: {
            code: 'MANDATORY_DISCLAIMER_MISSING',
            message: `Statutory holdout control failed: Required legal disclaimer or institutional decree text was omitted in candidate text.`,
            retryable: true,
            safeAction: 'Restore exact required legal disclaimer in typography region',
            detail: {
              missingDisclaimer: discl.text,
              role: discl.role,
            },
          },
        };
      }
    }

    // 4. Check for gross factual copy corruption (e.g. all headlines replaced or omitted)
    const headlineBlocks = (brief.exactCopy || []).filter((b) => b.role === 'headline');
    for (const h of headlineBlocks) {
      const normalizedHeadline = this.normalizeText(h.text);
      if (!normalizedCandidate.includes(normalizedHeadline)) {
        return {
          ok: false,
          error: {
            code: 'CORRUPTED_FACTUAL_COPY',
            message: `Authoritative headline '${h.text}' is missing or corrupted in candidate layout.`,
            retryable: true,
            safeAction: 'Restore approved headline from brief',
            detail: {
              expectedHeadline: h.text,
            },
          },
        };
      }
    }

    return {
      ok: true,
      value: {
        auditedTokensCount: expectedTokens.length,
        preservedTokens: expectedTokens,
        preservedBlocksCount: (brief.exactCopy || []).length,
        exactMatch: true,
        normalizedText: normalizedCandidate,
      },
    };
  }
}
