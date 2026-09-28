import { describe, it, expect } from 'vitest';
import type {
  TaskScope,
  StudioDocumentRef,
  MessageEnvelope,
  ContextPack,
  PublicationReceipt,
  QAReport,
} from '../src/index.js';

describe('Contracts: Type & Structure Validation', () => {
  it('contract: verifies TaskScope and client isolation structure', () => {
    const scope: TaskScope = {
      tenantId: 'tenant-100',
      clientId: 'client-200',
      projectId: 'proj-300',
      lockedAt: new Date().toISOString(),
    };
    expect(scope.tenantId).toBe('tenant-100');
    expect(scope.clientId).toBe('client-200');
  });

  it('contract: validates StudioDocumentRef schema versioning and hashes', () => {
    const docRef: StudioDocumentRef = {
      documentId: 'doc-1',
      studioDocumentId: 'hyc-1',
      sourceRevision: 1,
      sourceSha256: 'sha256-hash-1',
      studio: 'HyCanvas',
      studioVersion: '0.3.9',
      schemaVersion: '0.3.9',
    };
    expect(docRef.studio).toBe('HyCanvas');
    expect(docRef.sourceRevision).toBe(1);
  });

  it('contract (R02): validates ReleaseManifest topology and strict flag invariants', async () => {
    const { validateReleaseManifest } = await import('../src/release-manifest.js');

    const validManifest = {
      manifestVersion: '2.0.0',
      evidenceKind: 'source_candidate',
      targetEnvironment: 'production',
      topology: { canonical: 'infra/docker/docker-compose.prod.yml' },
      build: { commit: '664ad55b85930b3cd29c6be170fc13f0d2876f66', treeClean: true },
      flags: { DESIGN_PIPELINE_V3: 'off', DESIGN_STUDIO_V2: 'off' },
      models: { runtimeOverrides: 'unobserved' },
    };

    const valid = validateReleaseManifest(validManifest);
    expect(valid.ok).toBe(true);

    // Rejects non-canonical topology
    const wrongTopology = validateReleaseManifest({
      ...validManifest,
      topology: { canonical: 'deployment/docker-compose.yml' },
    });
    expect(wrongTopology.ok).toBe(false);

    // Rejects premature flag enabling before admission
    const enabledFlags = validateReleaseManifest({
      ...validManifest,
      flags: { DESIGN_PIPELINE_V3: 'on', DESIGN_STUDIO_V2: 'off' },
    });
    expect(enabledFlags.ok).toBe(false);

    const fabricatedImage = validateReleaseManifest({
      ...validManifest,
      components: { core: { service: 'core', imageStatus: 'unbuilt', image: 'hawa-core:latest' } },
    });
    expect(fabricatedImage.ok).toBe(false);
  });
});
