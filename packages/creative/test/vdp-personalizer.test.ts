import { describe, it, expect } from 'vitest';
import {
  computeHonoreeFontSize,
  formatHonoreeLine,
  personalizeInvitationOperations,
  VdpInvitationBatchRunner,
  type VdpGuestRecord,
} from '../src/vdp-personalizer.js';
import { buildKaaeInvitationOperations } from '../src/templates/kaae-invitation.template.js';

describe('VdpInvitationBatchRunner & Personalization Engine', () => {
  it('calculates dynamic font size scaling to prevent container overflow', () => {
    // Normal length name receives base 22px
    expect(computeHonoreeFontSize('Dr. Kawa Amin')).toBe(22);

    // Very long diplomatic title scales down gracefully
    const longTitle = 'His Excellency Prof. Dr. Mohammad Abdulrahman Al-Barzinji, Minister of Education';
    const scaled = computeHonoreeFontSize(longTitle);
    expect(scaled).toBeLessThan(22);
    expect(scaled).toBeGreaterThanOrEqual(16);
  });

  it('formats protocol honoree lines with proper honorifics', () => {
    expect(formatHonoreeLine({ id: 'g1', fullName: 'Aram Qadir', honorific: 'Dr.' })).toBe('Dr. Aram Qadir');
    expect(formatHonoreeLine({ id: 'g2', fullName: 'Hawzhin Ahmed' })).toBe('Hawzhin Ahmed');
    expect(
      formatHonoreeLine({
        id: 'g3',
        fullName: 'Alan Hama Saeed',
        honorific: 'His Excellency Minister',
      })
    ).toBe('His Excellency Minister Alan Hama Saeed');
  });

  it('personalizes template operations and applies protocol gold tier', () => {
    const baseOps = buildKaaeInvitationOperations({
      clientName: 'Kurdistan Accrediting Association for Education',
    });

    const guest: VdpGuestRecord = {
      id: 'vip_001',
      honorific: 'Dr.',
      fullName: 'Aram Mohammad',
      seatTier: 'diplomatic_corps',
    };

    const { operations, honoreeText, computedFontSize } = personalizeInvitationOperations(baseOps, guest);

    expect(honoreeText).toBe('Dr. Aram Mohammad');
    expect(computedFontSize).toBe(22);

    const salutationOp = operations.find((op) => op.op === 'addText' && op.nodeId === 'inv_salutation');
    expect(salutationOp).toBeDefined();
    if (salutationOp && salutationOp.op === 'addText') {
      expect(salutationOp.text).toBe('Dr. Aram Mohammad');
      expect((salutationOp.style as any).color).toBe('#FFD15C');
      expect((salutationOp.style as any).fontStyle).toBe('italic');
    }
  });

  it('processes a multi-guest batch with distinct cryptographic manifests', () => {
    const baseOps = buildKaaeInvitationOperations({
      clientName: 'Kurdistan Accrediting Association for Education',
    });

    const roster: VdpGuestRecord[] = [
      { id: 'g1', honorific: 'Dr.', fullName: 'Aram Mohammad' },
      { id: 'g2', honorific: 'Prof.', fullName: 'Kawa Qadir' },
      { id: 'g3', honorific: 'His Excellency', fullName: 'Alan Hama Saeed' },
    ];

    const runner = new VdpInvitationBatchRunner();
    const batch = runner.runBatch(baseOps, roster);

    expect(batch).toHaveLength(3);
    const hashes = new Set(batch.map((b) => b.manifestHash));
    expect(hashes.size).toBe(3); // Every guest produces a unique cryptographic manifest
  });
});
