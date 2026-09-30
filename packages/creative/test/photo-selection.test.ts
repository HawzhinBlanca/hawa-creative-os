import { describe, expect, it } from 'vitest';
import {
  omittedPhotoIndices,
  photoSelectionFromInstructions,
  photoSelectionOrUndefined,
  photoSelectionPrompt,
} from '../src/studio/photo-selection.js';

describe('photo selection from the requester\'s words (ADR-157, audit #17)', () => {
  it('reads English choice phrases', () => {
    for (const text of [
      "You don't have to use all the photos",
      'no need to use all of them',
      'choose the best ones',
      'Pick the best photos for the cover.',
      'select from these pictures',
      'use some of the photos',
      'not all the pictures need to go in',
      'Use whichever photos work',
    ]) {
      expect(photoSelectionFromInstructions(text, 6), text).toMatchObject({ mode: 'choose', minimum: 3 });
    }
  });

  it('takes a stated count as the minimum', () => {
    expect(photoSelectionFromInstructions('pick the best 4 photos', 6)).toMatchObject({ mode: 'choose', minimum: 4 });
    expect(photoSelectionFromInstructions('use two of them', 6)).toMatchObject({ mode: 'choose', minimum: 2 });
    expect(photoSelectionFromInstructions('choose 3', 5)).toMatchObject({ mode: 'choose', minimum: 3 });
  });

  it('reads Sorani choice phrases, in either keyboard spelling', () => {
    for (const text of [
      'پێویست ناکات هەموو وێنەکان دابنێیت',
      'باشترین وێنەکان هەڵبژێرە',
      'وێنە باشەکان هەڵبژێرە',
      'هەندێک لە وێنەکان بەکاربهێنە',
      'پێويست نييە هەموو وێنەكان',
    ]) {
      expect(photoSelectionFromInstructions(text, 6), text).toMatchObject({ mode: 'choose', minimum: 3 });
    }
    expect(photoSelectionFromInstructions('٤ وێنە هەڵبژێرە', 6)).toMatchObject({ mode: 'choose', minimum: 4 });
  });

  it('keeps every photo when nothing says otherwise', () => {
    for (const text of [
      '',
      'a report cover with these photos',
      'use the best colours from our brand',
      "don't use all caps",
      'pick a date in October',
    ]) {
      expect(photoSelectionFromInstructions(text, 6), text).toEqual({ mode: 'all', minimum: 6 });
    }
  });

  it('records when the requester insists on every photo (ADR-170), which binds an art-direction recipe', () => {
    for (const text of ['use all the photos', 'please include every picture', 'all 6 photos must be on it', 'هەموو وێنەکان دابنێ']) {
      expect(photoSelectionFromInstructions(text, 6), text).toEqual({ mode: 'all', minimum: 6, insisted: true });
    }
    // A choice phrase wins: "you don't have to use all the photos" is the owner's K-12 request.
    expect(photoSelectionFromInstructions("you don't have to use all the photos, choose the best ones", 6)).toMatchObject({ mode: 'choose' });
    expect(photoSelectionOrUndefined({ mode: 'all', minimum: 6, insisted: true }, 6)).toEqual({ mode: 'all', minimum: 6, insisted: true });
  });

  it('has nothing to choose with fewer than two photos, and a count of all of them is all', () => {
    expect(photoSelectionFromInstructions('choose the best ones', 1)).toEqual({ mode: 'all', minimum: 1 });
    expect(photoSelectionFromInstructions('use 6 of them', 6)).toEqual({ mode: 'all', minimum: 6 });
  });

  it('checks a stored selection and clamps it to the photos present', () => {
    expect(photoSelectionOrUndefined({ mode: 'choose', minimum: 4, matched: 'x' }, 3)).toEqual({ mode: 'choose', minimum: 3, matched: 'x' });
    expect(photoSelectionOrUndefined({ mode: 'all', minimum: 2 }, 5)).toEqual({ mode: 'all', minimum: 5 });
    expect(photoSelectionOrUndefined({ mode: 'choose', minimum: 0 }, 5)).toBeUndefined();
    expect(photoSelectionOrUndefined('choose', 5)).toBeUndefined();
  });

  it('lists the photos a design leaves out, and tells the layout model it may choose', () => {
    expect(omittedPhotoIndices([{ photoIndex: 0 }, { photoIndex: 3 }], 5)).toEqual([1, 2, 4]);
    expect(photoSelectionPrompt({ mode: 'choose', minimum: 3 }, 6)).toContain('place at least 3 of the 6');
    expect(photoSelectionPrompt({ mode: 'all', minimum: 6 }, 6)).toBe('');
  });
});
