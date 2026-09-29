import { describe, expect, it } from 'vitest';
import { detectFontRequests, unavailableFontNotice } from '../src/services/feedback-font-request.js';

/**
 * A reviewer wrote "we want to use Calibri for Kurdish". The handler used to answer with a canned
 * rule naming Cinzel, Playfair Display and Plus Jakarta Sans, record it against the client, and
 * print it back to the sender as their applied preference. Calibri is not a face the studio has,
 * and nothing in the message said Cinzel.
 *
 * These cases test the detector against the real font registry. The cases that sent the feedback
 * through the legacy Telegram webhook went with that route (ADR-135 stage 2).
 */

describe('detectFontRequests: the face a reviewer named', () => {
  it('reads Calibri for Kurdish as a request the studio cannot meet, and offers what it has', () => {
    const [req, ...rest] = detectFontRequests('we wanna use Calibri font for kurdish here and there');
    expect(rest).toEqual([]);
    expect(req.family).toBe('Calibri');
    expect(req.script).toBe('arabic');
    expect(req.available).toBe(false);
    expect(req.alternatives).toContain('Noto Sans Arabic');
    expect(req.alternatives).not.toContain('Verdana');
    expect(req.alternatives).not.toContain('Cairo');
    expect(req.alternatives).not.toContain('Calibri');
    const notice = unavailableFontNotice(req);
    expect(notice).toMatch(/Calibri is not installed/);
    expect(notice).toMatch(/Kurdish and Arabic/);
    expect(notice).not.toMatch(/Cinzel/);
  });

  it('reads an installed face as available, on the script it is admitted for', () => {
    const [amiri] = detectFontRequests('use Amiri for the Kurdish title');
    expect(amiri).toMatchObject({ family: 'Amiri', script: 'arabic', available: true, admittedFor: 'arabic' });
    const [cinzel] = detectFontRequests('use Cinzel for headers');
    expect(cinzel).toMatchObject({ family: 'Cinzel', script: 'unspecified', available: true, admittedFor: 'latin' });
  });

  it('refuses an installed face asked for on a script it does not cover', () => {
    const [req] = detectFontRequests('Cinzel for the Kurdish body text');
    expect(req.family).toBe('Cinzel');
    expect(req.available).toBe(false);
    expect(req.alternatives).toContain('Amiri');
  });

  it('resolves a registry alias to the admitted family, and keeps what was asked for', () => {
    const [req] = detectFontRequests('can we try Cormorant Garamond');
    expect(req).toMatchObject({ family: 'Cinzel', askedAs: 'Cormorant Garamond', available: true });
    const [short] = detectFontRequests('use Playfair for the headers');
    expect(short).toMatchObject({ family: 'Playfair Display', askedAs: 'Playfair', available: true });
  });

  it('does not read a venue, a name or a broadcaster as a font', () => {
    expect(detectFontRequests('the venue is in Dubai, move it under the date')).toEqual([]);
    expect(detectFontRequests('Georgia will attend; add the NRT logo')).toEqual([]);
    expect(detectFontRequests('inter alia the date is wrong')).toEqual([]);
    // With a type cue the same word is a font again.
    expect(detectFontRequests('use the Dubai font for Arabic')[0]).toMatchObject({ family: 'Dubai', available: false });
  });

  it('offers only faces whose files draw the Kurdish letters', () => {
    const [req] = detectFontRequests('please use Cairo for Kurdish');
    // Cairo is admitted by flag but its file lacks ڕ ڵ ۆ ێ ە on this host (registry note, 2026-09-20).
    expect(req.family).toBe('Cairo');
    expect(req.available).toBe(false);
    expect(req.alternatives).not.toContain('Cairo');
    expect(req.alternatives).toEqual(expect.arrayContaining(['Amiri', 'Noto Sans Arabic', 'IBM Plex Sans Arabic']));
  });

  it('reads the script from the sender\'s words, not from the family name', () => {
    const [req] = detectFontRequests('use IBM Plex Sans Arabic for the English text');
    expect(req).toMatchObject({ family: 'IBM Plex Sans Arabic', script: 'latin', available: false });
  });

  it('does not read "Arabic" inside "Noto Sans Arabic" as a second request, and reads Sorani as Kurdish', () => {
    const reqs = detectFontRequests('Noto Sans Arabic for Sorani please');
    expect(reqs.map((r) => r.family)).toEqual(['Noto Sans Arabic']);
    expect(reqs[0]).toMatchObject({ script: 'arabic', available: true });
  });

  it('names nothing when no face is named', () => {
    expect(detectFontRequests('make the font bigger')).toEqual([]);
    expect(detectFontRequests('the colours are wrong')).toEqual([]);
  });
});
