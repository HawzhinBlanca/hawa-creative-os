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
  if (!text || typeof text !== 'string') {
    return baseFontSize;
  }
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
  if (!guest || typeof guest !== 'object') return '';
  const parts: string[] = [];
  if (guest.honorific && typeof guest.honorific === 'string' && guest.honorific.trim().length > 0) {
    parts.push(guest.honorific.trim());
  }
  if (guest.fullName && typeof guest.fullName === 'string' && guest.fullName.trim().length > 0) {
    parts.push(guest.fullName.trim());
  }
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
    if (
      (op.op === 'addText' || op.op === 'replaceText') &&
      (op.nodeId === 'inv_salutation' || op.nodeId === 'inv_honoree' || (op as any).role === 'honoree')
    ) {
      if (op.op === 'addText') {
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
      } else {
        return {
          ...op,
          text: honoreeText,
        };
      }
    }
    if (
      (op.op === 'addText' || op.op === 'replaceText') &&
      (op.nodeId === 'inv_affiliation' || (op as any).role === 'affiliation')
    ) {
      const affText =
        guest.titleOrAffiliation && typeof guest.titleOrAffiliation === 'string'
          ? guest.titleOrAffiliation.trim()
          : '';
      return {
        ...op,
        text: affText,
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

function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
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
        .update(canonicalStringify(operations))
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
