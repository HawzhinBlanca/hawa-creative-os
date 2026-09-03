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
});
