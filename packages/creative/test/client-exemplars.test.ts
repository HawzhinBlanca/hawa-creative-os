import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ExemplarRetrievalIndex,
  ReferenceLibraryManager,
  findClientPack,
  loadClientExemplars,
  parseClientPacks,
  retrieveExemplarsV3,
  type ClientPack,
} from '../src/index.js';

/**
 * ADR-038: each client's designs are conditioned on its own owner-confirmed exemplars and on no other
 * client's. Every client used to be given KAAE's six.
 */
const KAAE_ID = 'c1000000-0000-4000-8000-000000000002';
const kaae = findClientPack('kaae')!;
const zar = findClientPack('zar-podcast')!;
const doc = (pack: object) => ({ source: `clients/${(pack as ClientPack).code}.json`, json: structuredClone(pack) });

/** A PNG header of the given size: enough for the library to read its dimensions. */
const png = (width: number, height: number, seed: number) => {
  const buf = Buffer.alloc(64);
  buf.set([0x89, 0x50, 0x4e, 0x47], 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt32BE(seed, 40);
  return buf;
};

describe("a client's exemplars", () => {
  it('are KAAE\'s own six for KAAE, recorded as KAAE\'s', () => {
    const set = loadClientExemplars(kaae)!;
    expect(set.clientId).toBe(KAAE_ID);
    expect(set.index.info.clientId).toBe(KAAE_ID);
    expect(set.index.getConfirmedExemplars().map((e) => e.filename).sort()).toEqual(
      new ExemplarRetrievalIndex().getConfirmedExemplars().map((e) => e.filename).sort()
    );
    // The images that ship with the package are the ones a design run is shown.
    const post1 = set.index.getConfirmedExemplars().find((e) => e.filename === 'post1_accreditation_mandate.png')!;
    expect(set.imageOf(post1)).toMatch(/assets\/exemplars\/post1_accreditation_mandate\.png$/);
  });

  it('retrieve for KAAE exactly as before they were per client', () => {
    const query = { text: 'Accreditation mandate for universities, statutory law', width: 1080, height: 1350 };
    const before = new ExemplarRetrievalIndex().retrieveTopExemplars({ text: query.text, format: '4:5', category: 'standards' }, 3);
    expect(retrieveExemplarsV3(query, loadClientExemplars(kaae)!.index).map((e) => e.id)).toEqual(before.retrievedIds);
  });

  it('are none, never KAAE\'s, for a client that has not confirmed any', () => {
    for (const code of ['zar-podcast', 'halwest-news', 'kawa-ba-hawlery', 'erbil-edition']) {
      const pack = findClientPack(code)!;
      expect(pack.exemplars).toBeNull();
      expect(pack.onboarding.missing).toContain('exemplars');
      expect(loadClientExemplars(pack)).toBeUndefined();
    }
    expect(retrieveExemplarsV3({ text: 'Episode 14 thumbnail', width: 1280, height: 720 }, undefined)).toEqual([]);
  });

  it("refuse a set recorded for another client", () => {
    const borrowed = { ...zar, exemplars: kaae.exemplars };
    expect(() => parseClientPacks([doc(kaae), doc(borrowed)])).toThrow(/kaae-exemplars\.json belongs to client c1000000-0000-4000-8000-000000000002, not zar-podcast/);
    expect(() => loadClientExemplars(borrowed as ClientPack)).toThrow(/belongs to client/);
  });
});

describe("a client's own words for retrieval", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-exemplars-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('let a thumbnail brief find the thumbnail that matches it', () => {
    const entry = (filename: string, reason: string, format = '16:9') => ({ rank: 1, filename, path: filename, format, aspectRatio: format, reason, recommendedFor: [], status: 'CONFIRMED' });
    const manifest = path.join(dir, 'exemplars.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        clientId: zar.id,
        vocabulary: ['interview', 'guest', 'breaking', 'football'],
        exemplars: [entry('guest.png', 'Close crop of the guest, interview hook in heavy type'), entry('match.png', 'Football match night, breaking score')],
      })
    );
    const index = new ExemplarRetrievalIndex(undefined, manifest);
    expect(retrieveExemplarsV3({ text: 'New interview with our guest', width: 1280, height: 720 }, index)[0].filename).toBe('guest.png');
    expect(retrieveExemplarsV3({ text: 'Breaking football final tonight', width: 1280, height: 720 }, index)[0].filename).toBe('match.png');
    // A set's own index never writes KAAE's embedding cache.
    expect(fs.readdirSync(dir)).toEqual(['exemplars.json']);
  });
});

describe("a client's exemplar library", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-library-'));
    fs.mkdirSync(path.join(root, 'packages/creative/assets'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('starts under the client\'s own directory, where its images ship, and records whose it is', () => {
    const manager = ReferenceLibraryManager.forClient(zar, root);
    expect(manager.manifestFile).toBe(path.join(root, 'packages/creative/assets/exemplars/zar-podcast/exemplars.json'));

    const added = manager.addPendingReference({ source: 'desk', fileBuffer: png(1280, 720, 1), filename: 'ep14.png', reason: 'Guest close-up' });
    expect(added.success).toBe(true);
    expect(added.entry?.path).toBe('packages/creative/assets/exemplars/zar-podcast/ep14.png');
    expect(added.entry?.format).toBe('16:9');
    expect(fs.existsSync(path.join(root, 'packages/creative/assets/exemplars/zar-podcast/ep14.png'))).toBe(true);

    const manifest = manager.getManifest();
    expect(manifest.clientId).toBe(zar.id);
    expect(manifest.imageDir).toBe('exemplars/zar-podcast');

    // Pending is never retrieved; confirmed is, from this client's set only.
    const indexOf = () => new ExemplarRetrievalIndex(undefined, manager.manifestFile);
    expect(indexOf().getConfirmedExemplars()).toEqual([]);
    expect(manager.confirmReference('ep14.png', { confirmedBy: 'Art Director (owner)' }).confirmedCount).toBe(1);
    expect(indexOf().getConfirmedExemplars().map((e) => e.filename)).toEqual(['ep14.png']);
    expect(indexOf().info.clientId).toBe(zar.id);
  });

  it("refuses to file one client's exemplars in another client's library", () => {
    const zarLibrary = path.join(root, 'packages/creative/assets/exemplars/zar-podcast');
    fs.mkdirSync(zarLibrary, { recursive: true });
    fs.writeFileSync(path.join(zarLibrary, 'exemplars.json'), JSON.stringify({ clientId: KAAE_ID, exemplars: [] }));
    expect(() => ReferenceLibraryManager.forClient(zar, root)).toThrow(/belongs to client c1000000-0000-4000-8000-000000000002, not zar-podcast/);
  });

  it("keeps KAAE's library where it was curated", () => {
    fs.copyFileSync(
      path.resolve(import.meta.dirname, '../assets/kaae-exemplars.json'),
      path.join(root, 'packages/creative/assets/kaae-exemplars.json')
    );
    const manager = ReferenceLibraryManager.forClient(kaae, root);
    const added = manager.addPendingReference({ source: 'folder_drop', fileBuffer: png(1080, 1350, 2), filename: 'new_notice.png' });
    expect(added.entry?.path).toBe('data/kaae-graphics/references/new_notice.png');
    expect(manager.getManifest().clientId).toBe(KAAE_ID);
  });
});
