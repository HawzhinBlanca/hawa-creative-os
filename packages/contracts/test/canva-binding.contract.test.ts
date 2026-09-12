import { describe, it, expect } from 'vitest';
import {
  type CanvaStudioBinding,
  type CaptureCanvaArtifactSetRequest,
  validateCanvaCaptureInvariants,
} from '../src/design-studio.js';

describe('Canva Studio Binding & Capture Contracts (ADR 020 / CV-04)', () => {
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002'; // KAAE
  const foreignClientId = 'c1000000-0000-4000-8000-000000000004'; // FastPay
  const taskId = 't1000000-0000-4000-9000-000000000001';
  const designId = 'DAHU6ovIEc4';
  const bindingId = 'b1000000-0000-4000-8000-000000000001';

  const validBinding: CanvaStudioBinding = {
    id: bindingId,
    tenantId,
    taskId,
    clientId,
    canvaDesignId: designId,
    canvaTeamId: 'team_kaae_creative',
    editUrl: `https://www.canva.com/design/${designId}/edit`,
    directionName: 'primary',
    status: 'bound',
    version: 3,
    createdAt: '2026-09-11T20:00:00Z',
    updatedAt: '2026-09-11T20:10:00Z',
  };

  const validRequest: CaptureCanvaArtifactSetRequest = {
    tenantId,
    taskId,
    clientId,
    canvaDesignId: designId,
    expectedVersion: 3,
    artifacts: [
      {
        format: 'pdf_print',
        storageKey: 'artifacts/kaae/2026/invitation_cmyk.pdf',
        sha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        byteSize: 1048576,
        colorSpace: 'cmyk',
        dpi: 300,
      },
      {
        format: 'png',
        storageKey: 'artifacts/kaae/2026/invitation_preview.png',
        sha256: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        byteSize: 524288,
        colorSpace: 'srgb',
      },
    ],
    exportSettings: {
      print: true,
      cmyk: true,
      bleed: true,
      cropMarks: true,
    },
    semanticCoverage: {
      textNodesCount: 5,
      imageFillsCount: 2,
      hasLogo: true,
      isComplete: true,
    },
    authActor: {
      actorType: 'user',
      actorId: 'usr_operator_hawzhin',
    },
  };

  it('proves server-derived client ownership: a design URL alone cannot select a client', () => {
    const crossClientRequest: CaptureCanvaArtifactSetRequest = {
      ...validRequest,
      clientId: foreignClientId, // Attempting to capture with an unauthorized foreign client ID
    };

    const result = validateCanvaCaptureInvariants(crossClientRequest, validBinding);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FOREIGN_CLIENT_DENIAL');
      expect(result.error.message).toContain('Cross-client violation');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('rejects foreign or unknown design IDs: cannot spoof or mismatch design ID', () => {
    const unknownDesignRequest: CaptureCanvaArtifactSetRequest = {
      ...validRequest,
      canvaDesignId: 'DAHX_UNKNOWN_SPOOFED',
    };

    const result = validateCanvaCaptureInvariants(unknownDesignRequest, validBinding);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN_DESIGN_DENIAL');
      expect(result.error.message).toContain('Design mismatch');
    }
  });

  it('rejects stale requests via optimistic locking: expected version must match current binding version', () => {
    const staleRequest: CaptureCanvaArtifactSetRequest = {
      ...validRequest,
      expectedVersion: 2, // Binding is currently at version 3
    };

    const result = validateCanvaCaptureInvariants(staleRequest, validBinding);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_VERSION_CONFLICT');
      expect(result.error.retryable).toBe(true);
      expect(result.error.detail?.expectedVersion).toBe(2);
      expect(result.error.detail?.currentVersion).toBe(3);
    }
  });

  it('strictly enforces snapshot completeness: incomplete snapshot cannot be represented as fully observed source', () => {
    const incompleteRequest: CaptureCanvaArtifactSetRequest = {
      ...validRequest,
      semanticCoverage: {
        textNodesCount: 2, // Missed text elements
        imageFillsCount: 0,
        hasLogo: false,
        isComplete: false, // Partial / incomplete observation
        unobservedLayersCount: 3,
      },
    };

    const result = validateCanvaCaptureInvariants(incompleteRequest, validBinding);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INCOMPLETE_SNAPSHOT_ERROR');
      expect(result.error.message).toContain('Snapshot incompleteness cannot be represented as fully observed source');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('rejects empty artifact sets', () => {
    const emptyArtifactsRequest: CaptureCanvaArtifactSetRequest = {
      ...validRequest,
      artifacts: [],
    };

    const result = validateCanvaCaptureInvariants(emptyArtifactsRequest, validBinding);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_REQUEST');
      expect(result.error.message).toContain('Artifact set cannot be empty');
    }
  });

  it('accepts valid, fully-observed capture sets satisfying all invariants', () => {
    const result = validateCanvaCaptureInvariants(validRequest, validBinding);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });
});
