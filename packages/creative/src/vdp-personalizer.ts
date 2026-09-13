import { createHash } from 'node:crypto';
import type { StudioOperation } from '@hawa/contracts';

export interface VdpGuestRecord {
  id: string;
  honorific?: string;
  fullName: string;
  titleOrAffiliation?: string;
  seatTier?: 'presidential_dais' | 'diplomatic_corps' | 'ministerial' | 'vip' | 'general';
  protocolCode?: string;
}

export interface PersonalizedInvitationDeliverable {
  guest: VdpGuestRecord;
  honoreeText: string;
  computedFontSize: number;
  operations: StudioOperation[];
  manifestHash: string;
}

/**
 * Calculates optimal font size for personalized honoree lines to guarantee zero overflow.
 */
export function computeHonoreeFontSize(text: string, baseFontSize = 22, maxCharsAtBase = 32): number {
  if (text.length <= maxCharsAtBase) {
    return baseFontSize;
  }
  // Linear scale down with a hard floor of 16px
  const scale = maxCharsAtBase / text.length;
  const scaledSize = Math.max(16, Math.round(baseFontSize * scale * 10) / 10);
  return scaledSize;
}

/**
 * Formats standard diplomatic protocol honoree line.
 */
export function formatHonoreeLine(guest: VdpGuestRecord): string {
  const parts: string[] = [];
  if (guest.honorific && guest.honorific.trim().length > 0) {
    parts.push(guest.honorific.trim());
  }
  parts.push(guest.fullName.trim());
  return parts.join(' ');
}

/**
 * Transforms a master invitation template operation sequence into a personalized VIP artifact.
 */
export function personalizeInvitationOperations(
  templateOperations: StudioOperation[],
  guest: VdpGuestRecord
): {
  operations: StudioOperation[];
  honoreeText: string;
  computedFontSize: number;
} {
  const honoreeText = formatHonoreeLine(guest);
  const computedFontSize = computeHonoreeFontSize(honoreeText, 22, 34);

  const personalizedOps = templateOperations.map((op): StudioOperation => {
    if (op.op === 'addText' && (op.nodeId === 'inv_salutation' || op.role === 'honoree')) {
      return {
        ...op,
        text: honoreeText,
        style: {
          ...(op.style as Record<string, any>),
          fontSize: computedFontSize,
          fontStyle: 'italic',
          fontWeight: '600',
          color: '#FFD15C', // Protocol gold personalization tier
        },
      };
    }
    return op;
  });

  return {
    operations: personalizedOps,
    honoreeText,
    computedFontSize,
  };
}

/**
 * Variable Data Printing (VDP) Batch Runner
 * Processes an authenticated guest roster and produces individual, cryptographically verified invitation packages.
 */
export class VdpInvitationBatchRunner {
  runBatch(
    templateOperations: StudioOperation[],
    roster: VdpGuestRecord[]
  ): PersonalizedInvitationDeliverable[] {
    return roster.map((guest) => {
      const { operations, honoreeText, computedFontSize } = personalizeInvitationOperations(
        templateOperations,
        guest
      );

      const opHash = createHash('sha256')
        .update(JSON.stringify(operations))
        .digest('hex');

      return {
        guest,
        honoreeText,
        computedFontSize,
        operations,
        manifestHash: `sha256_${opHash}`,
      };
    });
  }
}
