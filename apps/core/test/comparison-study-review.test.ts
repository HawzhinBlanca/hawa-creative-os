import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '@hawa/creative';
import { createDb } from '@hawa/db';
import { addJudge, addPair, cleanPng, createStudy, lockStudy, pngHeaderProblem } from '../src/services/comparison-study.js';

/**
 * Bug hunt on b2bbbb8: the stricter PNG checks. ImageMagick writes a cHRM chunk (the sRGB primaries)
 * into every PNG by default, and the PNG spec asks sRGB writers to add gAMA and cHRM for older
 * decoders; both are refused as "carries its own colour primaries", though the image is sRGB.
 */
describe('review of 2026-09-24: an sRGB PNG with a cHRM chunk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-png-'));
  const file = path.join(dir, 'poster.png');
  // A 1080x1350 RGB poster, as ImageMagick writes it by default.
  // ImageMagick 7 installs `magick`; Ubuntu's ImageMagick 6 only `convert`. Both write cHRM.
  const imagemagick = spawnSync('magick', ['-version']).error ? 'convert' : 'magick';
  execFileSync(imagemagick, ['-size', '1080x1350', 'gradient:#0A2A6B-#F7B500', '-depth', '8', file]);
  const bytes = fs.readFileSync(file);

  it('carries the sRGB primaries in its cHRM chunk', () => {
    const at = bytes.indexOf(Buffer.from('cHRM'));
    expect(at).toBeGreaterThan(0);
    // White point 0.3127,0.3290; red 0.64,0.33 (x100000): sRGB's own.
    expect([bytes.readUInt32BE(at + 4), bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12), bytes.readUInt32BE(at + 16)]).toEqual([31270, 32900, 64000, 33000]);
  });

  it('is accepted as a comparison image', () => {
    expect(pngHeaderProblem(bytes, 'designer PNG')).toBeUndefined();
    expect(() => cleanPng(bytes, 'designer PNG')).not.toThrow();
  });
});

/**
 * Bug hunt on b2bbbb8: judges are fixed once judging starts, and the claim now needs every planned
 * pair; lockStudy still starts judging with 2 pairs and 1 judge, so such a study can never hold.
 */
const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('review of 2026-09-24: a study locked short of its plan (PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const admin = { tenantId: '00000000-0000-4000-a000-000000000002', userId: '00000000-0000-4000-b000-000000000001', role: 'administrator', actorId: 'hunt_admin' } as any;
  const makePng = (rgb: [number, number, number]) => {
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 64; i++) png.data.set([...rgb, 255], i * 4);
    return PNG.sync.write(png);
  };
  it('is refused at lock, not found out at close', async () => {
    const study = await createStudy(db, admin, {
      name: 'hunt: short of plan',
      preregistration: {
        sample: '50 real office requests from the past month, chosen before anything is made.',
        judges: 'The requesters who sent the briefs and 3 designers from outside the office; every pair judged by at least 4.',
        analysis: 'Share of decisive judgements preferring Hawa with a Wilson 95% interval; the tie rate beside it.',
        threshold: 0.5, minDecisive: 194, minJudgesPerPair: 4, plannedPairs: 50,
      },
    });
    await addPair(db, admin, study.id, { hawaPng: makePng([1, 100, 1]), designerPng: makePng([100, 1, 1]) });
    await addPair(db, admin, study.id, { hawaPng: makePng([1, 1, 100]), designerPng: makePng([100, 100, 1]) });
    await addJudge(db, admin, study.id, { name: 'Only judge', kind: 'requester' });
    let locked = 'locked';
    await lockStudy(db, admin, study.id).catch((err) => { locked = `refused: ${err.message}`; });
    const late = await addJudge(db, admin, study.id, { name: 'Second judge', kind: 'designer' }).then(() => 'added', (err) => `refused (${err.status})`);
    await db.destroy();
    expect(locked).toMatch(/^refused/);
  });
});
