import { describe, it, expect } from 'vitest';
import { resolveLayoutArchetype } from '../src/services/canva-design-planner.js';

describe('Layout Archetype Selection (Never Hardcode One Design)', () => {
  it('rotates across diverse archetypes across subsequent plans so it never hardcodes one design', () => {
    expect(resolveLayoutArchetype('', 0)).toBe('sovereign_minimalism');
    expect(resolveLayoutArchetype('', 1)).toBe('royal_frame');
    expect(resolveLayoutArchetype('', 2)).toBe('academic_cream');
    expect(resolveLayoutArchetype('', 3)).toBe('asymmetric_editorial');
    expect(resolveLayoutArchetype('', 4)).toBe('bilateral_grid');
    expect(resolveLayoutArchetype('', 5)).toBe('executive_plinth');
    expect(resolveLayoutArchetype('', 6)).toBe('sovereign_minimalism');
  });

  it('selects sovereign_minimalism when user asks for cleaner, less boxy, or minimal design', () => {
    expect(resolveLayoutArchetype('make it cleaner and less boxy', 0)).toBe('sovereign_minimalism');
    expect(resolveLayoutArchetype('we want sovereign minimalism with no boxes', 0)).toBe('sovereign_minimalism');
    expect(resolveLayoutArchetype('too much clutter, give me more whitespace', 0)).toBe('sovereign_minimalism');
  });

  it('selects royal_frame when user asks for royal, ceremonial, or gold border frame', () => {
    expect(resolveLayoutArchetype('give it a royal gold frame border', 0)).toBe('royal_frame');
    expect(resolveLayoutArchetype('ceremonial framing with concentric borders', 0)).toBe('royal_frame');
  });

  it('selects academic_cream when user requests light or cream background', () => {
    expect(resolveLayoutArchetype('Use cream paper background with navy text', 0)).toBe('academic_cream');
    expect(resolveLayoutArchetype('Make it with a light background', 0)).toBe('academic_cream');
  });

  it('selects bilateral_grid when user asks for columns or side by side layout', () => {
    expect(resolveLayoutArchetype('can we try side by side columns', 0)).toBe('bilateral_grid');
    expect(resolveLayoutArchetype('twin bilateral grid for keynote and mou', 0)).toBe('bilateral_grid');
  });

  it('selects asymmetric_editorial when user asks for editorial or modern layout', () => {
    expect(resolveLayoutArchetype('make it modern editorial magazine style', 0)).toBe('asymmetric_editorial');
  });
});
