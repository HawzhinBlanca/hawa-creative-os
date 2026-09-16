import { describe, it, expect } from 'vitest';
import { ExemplarRetrievalIndex } from '../src/studio/exemplar-retrieval.js';

describe('P02 — Exemplar Retrieval (arXiv 2311.13602 RALF)', () => {
  const index = new ExemplarRetrievalIndex();

  it('loads all six confirmed exemplars and filters out dropped and pending entries', () => {
    const exemplars = index.getConfirmedExemplars();
    expect(exemplars.length).toBe(6);

    const filenames = exemplars.map(e => e.filename);
    expect(filenames).toContain('post1_accreditation_mandate.png');
    expect(filenames).toContain('post2_standards_higher_ed.png');
    expect(filenames).toContain('post3_strategic_roadmap.png');
    expect(filenames).toContain('AUK002 kurdi.jpg.jpeg');
    expect(filenames).toContain('CC002 kurdi.jpg.jpeg');
    expect(filenames).toContain('CUE002 kurdi.jpg.jpeg');

    // Never includes circular system-generated or dropped entries
    expect(filenames).not.toContain('KAAE_Commences_2026_Cycle_1080x1350.png');
    expect(filenames).not.toContain('image16.png');
    expect(filenames).not.toContain('image17.png');
    expect(filenames).not.toContain('image19.png');
    expect(filenames).not.toContain('kaae 5 kurdi.jpg.jpeg');
    expect(filenames).not.toContain('call for kurdi.jpg.jpeg');
  });

  it('retrieves different exemplar sets for distinct briefs, eliminating first-3 truncation', () => {
    const briefA = {
      text: 'English institutional announcement of academic standards, policy guidelines, and accreditation mandate for universities',
      format: '1:1',
      category: 'standards',
    };

    const briefB = {
      text: 'Kurdish Sorani partnership milestone and institutional recognition with American University of Kurdistan (AUK) and Catholic University in Erbil (CUE)',
      format: '4:5',
      category: 'partnership_announcement',
    };

    const resA = index.retrieveTopExemplars(briefA, 3);
    const resB = index.retrieveTopExemplars(briefB, 3);

    expect(resA.retrievedExemplars.length).toBe(3);
    expect(resB.retrievedExemplars.length).toBe(3);

    expect(resA.retrievedIds).not.toEqual(resB.retrievedIds);

    // Brief A should prioritize standards & square formats (post1, post2, post3)
    const setA = new Set(resA.retrievedExemplars.map(e => e.filename));
    expect(setA.has('post1_accreditation_mandate.png') || setA.has('post2_standards_higher_ed.png')).toBe(true);

    // Brief B should prioritize Kurdish institutional partnership cards (AUK, CUE, CC)
    const setB = new Set(resB.retrievedExemplars.map(e => e.filename));
    expect(setB.has('AUK002 kurdi.jpg.jpeg') || setB.has('CUE002 kurdi.jpg.jpeg')).toBe(true);

    // Verification of hard SLA and zero cost
    expect(resA.executionTimeMs).toBeLessThan(100);
    expect(resB.executionTimeMs).toBeLessThan(100);
    expect(resA.apiCostUsd).toBe(0);
    expect(resB.apiCostUsd).toBe(0);
  });
});
