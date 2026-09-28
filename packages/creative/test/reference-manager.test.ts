import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ReferenceLibraryManager } from '../src/studio/reference-manager.js';
import { ExemplarRetrievalIndex } from '../src/studio/exemplar-retrieval.js';

describe('P11 — Reference Library & Ingestion Manager', () => {
  const rootDir = fs.existsSync(path.resolve(process.cwd(), 'packages'))
    ? process.cwd()
    : path.resolve(process.cwd(), '../..');
  const tmpDir = path.resolve(rootDir, 'tmp/test-reference-manager');
  const tmpManifest = path.join(tmpDir, 'kaae-exemplars.json');
  const realManifestPath = path.resolve(rootDir, 'packages/creative/assets/kaae-exemplars.json');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Copy real manifest into tmp
    fs.copyFileSync(realManifestPath, tmpManifest);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves droppedInReview history intact across additions and updates', () => {
    const manager = new ReferenceLibraryManager(rootDir, tmpManifest, path.join(tmpDir, 'references'));
    const initialManifest = manager.getManifest();
    expect(initialManifest.droppedInReview.entries.length).toBe(6);

    const syntheticPng = Buffer.alloc(100);
    // Add dummy PNG header
    syntheticPng[0] = 0x89;
    syntheticPng[1] = 0x50;
    syntheticPng[2] = 0x4e;
    syntheticPng[3] = 0x47;
    syntheticPng.writeUInt32BE(1080, 16);
    syntheticPng.writeUInt32BE(1350, 20);

    manager.addPendingReference({
      source: 'folder_drop',
      fileBuffer: syntheticPng,
      filename: 'new_test_ref.png',
      reason: 'Testing reference addition',
    });

    const updated = manager.getManifest();
    expect(updated.droppedInReview.entries.length).toBe(6);
    expect(updated.droppedInReview.entries[0].filename).toBe('KAAE_Commences_2026_Cycle_1080x1350.png');
  });

  it('refuses to add any file generated under output/ (hard guard against circular references)', () => {
    const manager = new ReferenceLibraryManager(rootDir, tmpManifest, path.join(tmpDir, 'references'));

    // Pick a real file from output/proofs/
    const proofFile = path.resolve(rootDir, 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_01/preview.png');
    expect(fs.existsSync(proofFile)).toBe(true);

    const outputBuf = fs.readFileSync(proofFile);

    const res = manager.addPendingReference({
      source: 'folder_drop',
      fileBuffer: outputBuf,
      filename: 'fake_incoming_ref.png',
    });

    expect(res.success).toBe(false);
    expect(res.refused).toBe(true);
    expect(res.matchingPath).toContain('output/');
    expect(res.reason).toContain('System-produced designs cannot be added as references');
  });

  it('exercises all 3 entry points (folder_drop, telegram, desk) and saves as pending', () => {
    const manager = new ReferenceLibraryManager(rootDir, tmpManifest, path.join(tmpDir, 'references'));

    const createDummyPng = (seed: string) => {
      const b = Buffer.alloc(128);
      b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
      b.writeUInt32BE(1080, 16);
      b.writeUInt32BE(1080, 20);
      b.write(seed, 32);
      return b;
    };

    // 1. Folder drop
    const resDrop = manager.addPendingReference({
      source: 'folder_drop',
      fileBuffer: createDummyPng('drop-seed-123'),
      filename: 'sample_dropped.png',
    });
    expect(resDrop.success).toBe(true);
    expect(resDrop.entry?.status).toBe('pending');
    expect(resDrop.entry?.source).toBe('folder_drop');

    // 2. Telegram
    const resTg = manager.addPendingReference({
      source: 'telegram',
      fileBuffer: createDummyPng('tg-seed-456'),
      filename: 'sample_telegram.png',
      sender: 'art_director_chat_882',
    });
    expect(resTg.success).toBe(true);
    expect(resTg.entry?.status).toBe('pending');
    expect(resTg.entry?.source).toBe('telegram');
    expect(resTg.entry?.sender).toBe('art_director_chat_882');

    // 3. Desk
    const resDesk = manager.addPendingReference({
      source: 'desk',
      fileBuffer: createDummyPng('desk-seed-789'),
      filename: 'sample_desk.png',
      sender: 'lead_designer_usr',
    });
    expect(resDesk.success).toBe(true);
    expect(resDesk.entry?.status).toBe('pending');
    expect(resDesk.entry?.source).toBe('desk');
    expect(resDesk.entry?.sender).toBe('lead_designer_usr');
  });

  it('retrieval index (P02) ignores pending references, and includes them after owner confirmation', () => {
    const manager = new ReferenceLibraryManager(rootDir, tmpManifest, path.join(tmpDir, 'references'));

    const dummyPng = Buffer.alloc(128);
    dummyPng[0] = 0x89; dummyPng[1] = 0x50; dummyPng[2] = 0x4e; dummyPng[3] = 0x47;
    dummyPng.writeUInt32BE(1080, 16);
    dummyPng.writeUInt32BE(1080, 20);
    dummyPng.write('unique_kurdish_milestone_exemplar', 32);

    const addRes = manager.addPendingReference({
      source: 'folder_drop',
      fileBuffer: dummyPng,
      filename: 'kurdish_accreditation_diploma_2026.png',
      reason: 'Kurdish institutional accreditation diploma with gold crest',
      recommendedFor: ['accreditation_milestone'],
    });

    expect(addRes.success).toBe(true);

    // Initial check: P02 retrieval does NOT retrieve pending
    const indexBefore = new ExemplarRetrievalIndex({ manifestPath: tmpManifest });
    const retrievedBefore = indexBefore.getConfirmedExemplars();
    expect(retrievedBefore.find(e => e.filename === 'kurdish_accreditation_diploma_2026.png')).toBeUndefined();

    // Owner confirmation gate
    const confirmRes = manager.confirmReference('kurdish_accreditation_diploma_2026.png', {
      confirmedBy: 'Art Director (owner)',
      targetRank: 2,
    });

    expect(confirmRes.success).toBe(true);
    expect(confirmRes.entry?.status).toBe('CONFIRMED');
    expect(confirmRes.entry?.rank).toBe(2);
    expect(confirmRes.confirmedCount).toBe(7);

    // Re-check: manifest now has 7 confirmed exemplars
    const manifestAfter = manager.getManifest();
    expect(manifestAfter.totalExemplars).toBe(7);
    const confirmedList = manifestAfter.exemplars.filter(e => e.status !== 'pending' && e.status !== 'dropped');
    expect(confirmedList.length).toBe(7);
    expect(indexBefore.retrieveTopExemplars({ text: 'diploma' }, 1).retrievedExemplars[0].filename).toBe('kurdish_accreditation_diploma_2026.png');
    expect(confirmedList[1].filename).toBe('kurdish_accreditation_diploma_2026.png');
  });
});
