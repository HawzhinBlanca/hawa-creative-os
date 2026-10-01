import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExemplarRetrievalIndex, PHOTO_RECIPE_IDS } from '../src/studio/exemplar-retrieval.js';
import { parseImageDimensions } from '../src/studio/reference-manager.js';

// ADR-170: the office's own published photo designs as recipe-tagged references.
const assets = path.resolve(import.meta.dirname, '../assets');
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'kaae-exemplars.json'), 'utf8'));
const photoEntries = manifest.exemplars.filter((e: any) => e.status === 'office-published');
const withoutPhotos = { ...manifest, exemplars: manifest.exemplars.filter((e: any) => e.status !== 'office-published') };
const index = new ExemplarRetrievalIndex({ manifest });

const K12_REPORT = {
  text: 'KAAE K-12 Pilot Study Field Visit Report. Insights from KAAE school field visits and next steps toward education quality improvement. Read the full report at kaae.org',
  format: '4:5',
};
const TYPOGRAPHIC_BRIEFS = [
  { text: 'English institutional announcement of academic standards, policy guidelines, and accreditation mandate for universities', format: '1:1', category: 'standards' },
  { text: 'Kurdish Sorani partnership milestone and institutional recognition with American University of Kurdistan (AUK) and Catholic University in Erbil (CUE)', format: '4:5', category: 'partnership_announcement' },
  { text: 'KAAE Accreditation Standards', format: '1:1', category: 'standards' },
  { text: 'meeting with officials, field visit report and partnership', format: '4:5' },
  { text: 'ڕێنمایی نوێی زانکۆکان' },
  { text: '' },
];

describe('Office-published photo exemplars (ADR-170)', () => {
  it('retains 8-12 office photo designs covering the original seven recipes, downscaled, hashed and traced to their source', () => {
    expect(photoEntries.length).toBeGreaterThanOrEqual(8);
    expect(photoEntries.length).toBeLessThanOrEqual(12);
    expect(new Set(photoEntries.map((e: any) => e.recipe))).toEqual(new Set([
      'hero_fade_report', 'hero_plate', 'hero_card', 'cutout_speaker', 'sky_title', 'scrim_caption', 'fade_to_paper',
    ]));
    expect(photoEntries.every((e: any) => PHOTO_RECIPE_IDS.includes(e.recipe))).toBe(true);
    for (const e of photoEntries) {
      const bytes = fs.readFileSync(path.join(assets, 'exemplars', e.filename));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(e.sha256);
      expect(bytes.length).toBe(e.fileSizeBytes);
      const { width, height } = parseImageDimensions(bytes);
      expect({ width, height }).toEqual(e.dimensions);
      expect(Math.max(width, height)).toBeLessThanOrEqual(1080);
      expect(e.path).toBe(`packages/creative/assets/exemplars/${e.filename}`);
      expect(e.photoCount).toBeGreaterThan(0);
      expect(e.subject.length).toBeGreaterThan(0);
      expect(e.provenance.sourceFile).toBeTruthy();
      expect(e.provenance.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Descriptors go to the layout model as text: English only, Kurdish copy described in English.
      expect(e.descriptor.length).toBeGreaterThan(200);
      expect(e.descriptor).not.toMatch(/[؀-ۿ]/u);
      if (e.pairedWith) {
        const twin = photoEntries.find((t: any) => t.filename.startsWith(`${e.pairedWith}.`));
        expect(twin?.pairedWith).toBe(path.parse(e.filename).name);
        expect(twin?.recipe).toBe(e.recipe);
      }
    }
    // The office's own version of the K-12 field visit brief, in both languages.
    const k12 = photoEntries.filter((e: any) => /^kaae raphic (kurdi )?10\.jpg\.jpeg$/.test(e.provenance.sourceFile));
    expect(k12.map((e: any) => [e.recipe, e.language, e.photoCount])).toEqual([
      ['hero_fade_report', 'en', 2], ['hero_fade_report', 'ckb', 2]]);
  });

  it('exposes the five new geometries without admitted references and never invents coverage', () => {
    const result = index.retrieveTopExemplars({ ...K12_REPORT, photoCount: 6 }, 3);
    expect(result.evidence.photoRecipeCoverage?.eligible).toHaveLength(12);
    expect(result.evidence.photoRecipeCoverage?.represented).toHaveLength(7);
    expect(new Set(result.evidence.photoRecipeCoverage?.missing)).toEqual(new Set([
      'hero_storyboard', 'editorial_split', 'photo_diptych', 'photo_sequence', 'photo_mosaic',
    ]));
    expect(result.evidence.warnings.some(w => w.startsWith('MISSING_PHOTO_RECIPE_EXEMPLARS:'))).toBe(true);
    const unavailable = index.retrieveTopExemplars({ text: 'Speaker', photoCount: 1, eligibleRecipes: ['cutout_speaker'] }, 3, []);
    expect(unavailable.evidence.photoRecipeCoverage?.represented).toEqual([]);
    expect(unavailable.evidence.photoRecipeCoverage?.missing).toEqual(['cutout_speaker']);
    expect(unavailable.retrievedExemplars).toEqual([]);
    expect(unavailable.evidence.warnings.some(w => w.startsWith('MISSING_PHOTO_RECIPE_EXEMPLARS:'))).toBe(true);
  });

  it('reinstates the dropped photo post with its reasoning and keeps the dropped history', () => {
    const dropped = manifest.droppedInReview.entries.find((e: any) => e.filename === 'kaae 5 kurdi.jpg.jpeg');
    expect(dropped.reason).toContain('not a layout to learn composition from');
    expect(dropped.reconsideredAt).toBe('2026-09-30');
    expect(dropped.reconsideration).toContain('scrim_caption');
    const reinstated = photoEntries.find((e: any) => e.provenance.sourceFile === 'kaae 5 kurdi.jpg.jpeg');
    expect(reinstated.recipe).toBe('scrim_caption');
    expect(manifest.droppedInReview.entries.length).toBe(6);
  });

  it('keeps typographic briefs exactly as they were: photo exemplars take no part in their ranking', () => {
    const before = new ExemplarRetrievalIndex({ manifest: withoutPhotos });
    for (const brief of TYPOGRAPHIC_BRIEFS) for (const photoCount of [undefined, 0]) {
      const now = index.retrieveTopExemplars({ ...brief, photoCount }, 3);
      const then = before.retrieveTopExemplars(brief, 3);
      expect(now.retrievedExemplars).toEqual(then.retrievedExemplars);
      expect({ ...now.evidence, manifestSha256: '' }).toEqual({ ...then.evidence, manifestSha256: '' });
      expect(now.retrievedExemplars.every(e => e.status === 'CONFIRMED' && e.recipe === 'typographic')).toBe(true);
    }
  });

  it('gives a report brief with photos the office report post first, then two other recipes', () => {
    const result = index.retrieveTopExemplars({ ...K12_REPORT, photoCount: 2, subjects: ['report_release'] }, 3);
    expect(result.evidence.mode).toBe('photo_recipe');
    expect(result.retrievedIds[0]).toBe('photo01_k12_field_visit_report_en');
    expect(result.retrievedExemplars).toHaveLength(3);
    expect(new Set(result.retrievedExemplars.map(e => e.recipe)).size).toBe(3);
    const first = result.retrievedExemplars[0];
    expect(first.recipe).toBe('hero_fade_report');
    expect(first.descriptor).toBe(photoEntries[0].descriptor);
    expect(first.subject).toContain('report_release');
    expect(result.evidence.matches[0]).toMatchObject({ recipe: 'hero_fade_report', subjectMatches: ['report_release'] });
    expect(result.evidence.warnings).toEqual([
      expect.stringMatching(/^MISSING_PHOTO_RECIPE_EXEMPLARS:/),
    ]);
    expect(result.apiCostUsd).toBe(0);
  });

  it('gives a Sorani brief the Sorani twin of the same design', () => {
    const result = index.retrieveTopExemplars({ text: 'ڕاپۆرتی سەردانی مەیدانی قوتابخانەکان', photoCount: 1, subjects: ['report_release'] }, 3);
    expect(result.retrievedIds[0]).toBe('photo02_k12_field_visit_report_ckb');
    expect(result.retrievedIds).not.toContain('photo01_k12_field_visit_report_en');
  });

  it('offers only eligible recipes, subject first, and adds a language twin only when recipes run out', () => {
    const meeting = index.retrieveTopExemplars({ text: 'KAAE met the Minister of Education', photoCount: 1,
      subjects: ['meeting', 'officials'], eligibleRecipes: ['scrim_caption', 'sky_title'] }, 3);
    expect(meeting.retrievedIds).toEqual(['photo07_prime_minister_meeting_scrim_en', 'photo09_eid_al_adha_sky_title',
      'photo08_prime_minister_meeting_scrim_ckb']);
    const speaker = index.retrieveTopExemplars({ text: 'Webinar with a guest speaker', photoCount: 1, category: 'event_forum' }, 1);
    expect(speaker.retrievedExemplars.map(e => e.recipe)).toEqual(['cutout_speaker']);
  });

  it('with no subject evidence, still returns recipe-diverse photo exemplars and says so', () => {
    const result = index.retrieveTopExemplars({ text: 'zzz', photoCount: 3 }, 3);
    expect(result.evidence.mode).toBe('photo_recipe');
    expect(new Set(result.retrievedExemplars.map(e => e.recipe)).size).toBe(3);
    expect(result.evidence.warnings[0]).toMatch(/^NO_SUBJECT_MATCH/);
  });

  it('respects availability and falls back to typographic exemplars when no photo exemplar is eligible', () => {
    const available = index.getConfirmedExemplars().map(e => e.id).filter(id => id !== 'photo01_k12_field_visit_report_en');
    const unavailable = index.retrieveTopExemplars({ ...K12_REPORT, photoCount: 2, subjects: ['report_release'] }, 3, available);
    expect(unavailable.retrievedIds).not.toContain('photo01_k12_field_visit_report_en');
    expect(unavailable.retrievedIds[0]).toBe('photo02_k12_field_visit_report_ckb');

    const none = index.retrieveTopExemplars({ ...K12_REPORT, photoCount: 2, eligibleRecipes: ['typographic'] }, 3);
    expect(none.evidence.algorithm).toBe('unicode-bm25-v1');
    expect(none.retrievedExemplars.every(e => e.recipe === 'typographic')).toBe(true);
    expect(none.evidence.warnings[0]).toMatch(/^NO_ELIGIBLE_PHOTO_EXEMPLAR/);
  });

  it('refuses photo metadata that contradicts itself, and an office post in the typographic set', () => {
    const one = (more: Record<string, unknown>) => new ExemplarRetrievalIndex({ manifest: { status: 'CONFIRMED', exemplars: [
      { filename: 'x.jpg', path: 'x.jpg', rank: 1, reason: 'r', status: 'office-published', recipe: 'hero_card', photoCount: 1, ...more }] } });
    expect(() => one({})).not.toThrow();
    expect(() => one({ recipe: 'collage' })).toThrow('invalid');
    expect(() => one({ photoCount: 0 })).toThrow('invalid');
    expect(() => one({ recipe: 'typographic', photoCount: 0 })).toThrow('invalid');
    expect(() => one({ recipe: undefined, photoCount: undefined })).toThrow('invalid');
    expect(() => one({ status: 'CONFIRMED', recipe: 'typographic', photoCount: 2 })).toThrow('invalid');
    expect(() => one({ subject: 'meeting' })).toThrow('invalid');
    expect(one({ status: 'pending' }).getConfirmedExemplars()).toEqual([]);
  });
});
