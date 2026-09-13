import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computeDocumentHash,
  computeDraftManifestHash,
  verifyDraftIntegrity,
  reconcileDrafts,
  persistWorkingDraft,
  loadWorkingDraft,
  getEffectiveStorage,
  deleteWorkingDraft,
  getLastActiveDraftId,
  setCustomDurableStorage,
  type SavedCanvasDraft,
  type DraftSaveState,
} from '../src/services/draftStorage.js';

describe('Hawa Desk — Offline Draft Storage Engine & Reconciliation (ME-02, ME-03, ME-04, ME-06)', () => {
  const sampleDraft: SavedCanvasDraft = {
    id: 'test_draft_01',
    taskId: 'task_kaae_001',
    clientId: 'kaae',
    version: 3,
    headlineEn: 'Mastering Brand Excellence',
    headlineCkb: 'شارەزابوون لە ناسنامەی براند',
    copyEn: 'Executive Invitation',
    copyCkb: 'بانگهێشتنامەی فەرمی',
    fontFamily: 'Inter',
    fontWeight: 700,
    accentColor: '#0EA5E9',
    brandKitId: 'kaae',
    format: 'feed',
    langVariant: 'bilingual',
    nodes: [
      { id: 'n1', role: 'headline', textEn: 'Mastering Brand Excellence' },
      { id: 'n2', role: 'copy', textEn: 'Executive Invitation' },
    ],
    zoom: 1,
    panOffset: { x: 0, y: 0 },
    selectedNodeIds: ['n1'],
    updatedAt: 1700000000000,
  };

  beforeEach(() => {
    // Clear localStorage mock if defined
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('ME-06: computes deterministic canonical SHA-256 manifest hash regardless of key order', async () => {
    const hash1 = await computeDraftManifestHash(sampleDraft);
    expect(hash1).toMatch(/^sha256_/);

    // Reorder draft object keys
    const reorderedDraft: SavedCanvasDraft = {
      updatedAt: sampleDraft.updatedAt,
      id: sampleDraft.id,
      version: sampleDraft.version,
      langVariant: sampleDraft.langVariant,
      nodes: sampleDraft.nodes,
      format: sampleDraft.format,
      clientId: sampleDraft.clientId,
      brandKitId: sampleDraft.brandKitId,
      accentColor: sampleDraft.accentColor,
      fontWeight: sampleDraft.fontWeight,
      fontFamily: sampleDraft.fontFamily,
      copyCkb: sampleDraft.copyCkb,
      copyEn: sampleDraft.copyEn,
      headlineCkb: sampleDraft.headlineCkb,
      headlineEn: sampleDraft.headlineEn,
      zoom: 1,
      panOffset: { x: 0, y: 0 },
      selectedNodeIds: [],
    };

    const hash2 = await computeDraftManifestHash(reorderedDraft);
    expect(hash1).toBe(hash2);

    // Changing content alters the hash
    const modifiedDraft: SavedCanvasDraft = {
      ...sampleDraft,
      headlineEn: 'Tampered Title',
    };
    const hash3 = await computeDraftManifestHash(modifiedDraft);
    expect(hash1).not.toBe(hash3);

    // Changing fontFamily, fontWeight, or langVariant MUST alter the hash
    const fontChangedDraft: SavedCanvasDraft = { ...sampleDraft, fontFamily: 'Cairo' };
    expect(await computeDraftManifestHash(fontChangedDraft)).not.toBe(hash1);

    const weightChangedDraft: SavedCanvasDraft = { ...sampleDraft, fontWeight: 900 };
    expect(await computeDraftManifestHash(weightChangedDraft)).not.toBe(hash1);

    const langChangedDraft: SavedCanvasDraft = { ...sampleDraft, langVariant: 'ckb' };
    expect(await computeDraftManifestHash(langChangedDraft)).not.toBe(hash1);
  });

  it('ME-06: verifies draft integrity and detects tamper/corruption', async () => {
    const validDraft = { ...sampleDraft };
    validDraft.sha256Proof = await computeDraftManifestHash(validDraft);

    expect(await verifyDraftIntegrity(validDraft)).toBe(true);

    // Simulate silent corruption in copy
    const corruptedDraft = {
      ...validDraft,
      copyEn: 'Corrupted Unauthorized Edit',
    };
    expect(await verifyDraftIntegrity(corruptedDraft)).toBe(false);
  });

  it('ME-04: preserves explicit empty strings and empty node array without dropping values', async () => {
    const emptyValuesDraft: SavedCanvasDraft = {
      ...sampleDraft,
      id: 'draft_empty_values',
      headlineEn: '',
      headlineCkb: '',
      copyEn: '',
      copyCkb: '',
      nodes: [],
      updatedAt: 1700000005000,
    };

    const hash = await computeDraftManifestHash(emptyValuesDraft);
    expect(hash).toBeDefined();

    // Verify localStorage round trip preserves "" and []
    if (typeof localStorage !== 'undefined') {
      await persistWorkingDraft(emptyValuesDraft);
      const loaded = await loadWorkingDraft('draft_empty_values');
      expect(loaded).not.toBeNull();
      expect(loaded?.headlineEn).toBe('');
      expect(loaded?.headlineCkb).toBe('');
      expect(loaded?.copyEn).toBe('');
      expect(loaded?.copyCkb).toBe('');
      expect(loaded?.nodes).toEqual([]);
    }
  });

  it('ME-03: reconciles newer localStorage fallback over older stale draft', async () => {
    if (typeof localStorage === 'undefined') return;

    const olderDraft: SavedCanvasDraft = {
      ...sampleDraft,
      id: 'reconcile_test',
      version: 1,
      updatedAt: 1000,
      headlineEn: 'Stale Old Version',
    };

    const newerDraft: SavedCanvasDraft = {
      ...sampleDraft,
      id: 'reconcile_test',
      version: 2,
      updatedAt: 2000,
      headlineEn: 'Fresh Modern Version',
    };
    newerDraft.sha256Proof = await computeDraftManifestHash(newerDraft);

    // Store the newer draft in localStorage fallback
    localStorage.setItem('hawa_draft_reconcile_test', JSON.stringify(newerDraft));

    const result = await reconcileDrafts('reconcile_test');
    expect(result.restored).not.toBeNull();
    expect(result.restored?.headlineEn).toBe('Fresh Modern Version');
    expect(result.restored?.version).toBe(2);
  });

  it('ME-03: rejects corrupted drafts and refuses to certify forged or corrupted payloads', async () => {
    const storage = getEffectiveStorage();

    const corruptedDraft: SavedCanvasDraft = {
      ...sampleDraft,
      id: 'corrupted_draft_test',
      headlineEn: 'Corrupted Unauthorized Payload',
      sha256Proof: 'sha256_0000000000000000000000000000000000000000000000000000000000000000',
    };

    storage.setItem('hawa_draft_corrupted_draft_test', JSON.stringify(corruptedDraft));

    const result = await reconcileDrafts('corrupted_draft_test');
    expect(result.restored).toBeNull();
    expect(result.error).toBe('INTEGRITY_VERIFICATION_FAILED');

    const loaded = await loadWorkingDraft('corrupted_draft_test');
    expect(loaded).toBeNull();
  });

  it('ME-03: rejects unhashed legacy drafts by default and refuses to auto-certify unhashed drafts', async () => {
    const storage = getEffectiveStorage();

    const unhashedDraft: SavedCanvasDraft = {
      ...sampleDraft,
      id: 'unhashed_draft_test',
      headlineEn: 'Unhashed Legacy Draft',
      // No sha256Proof
    };

    storage.setItem('hawa_draft_unhashed_draft_test', JSON.stringify(unhashedDraft));

    // Default loadWorkingDraft rejects unhashed drafts
    const loaded = await loadWorkingDraft('unhashed_draft_test');
    expect(loaded).toBeNull();

    // ReconcileDrafts reports UNHASHED_LEGACY_DRAFT_REJECTED
    const result = await reconcileDrafts('unhashed_draft_test');
    expect(result.restored).toBeNull();
    expect(result.error).toBe('UNHASHED_LEGACY_DRAFT_REJECTED');
    expect(result.isLegacyUnhashed).toBe(true);

    // Verify it was NOT given a new valid hash in storage
    const inStorage = JSON.parse(storage.getItem('hawa_draft_unhashed_draft_test')!);
    expect(inStorage.sha256Proof).toBeUndefined();
  });

  it('deleteWorkingDraft purges the draft and cleans up hawa_last_active_draft_id', async () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => { map.clear(); },
    };
    setCustomDurableStorage(storage);

    const draft: SavedCanvasDraft = {
      ...sampleDraft,
      id: 'draft_to_delete_01',
    };

    await persistWorkingDraft(draft);
    expect(getLastActiveDraftId()).toBe('draft_to_delete_01');

    await deleteWorkingDraft('draft_to_delete_01');
    expect(await loadWorkingDraft('draft_to_delete_01')).toBeNull();
    expect(getLastActiveDraftId()).toBeNull();

    setCustomDurableStorage(null);
  });
});
