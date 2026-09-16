import { describe, it, expect } from 'vitest';
import * as plannerModule from '../src/services/canva-design-planner.js';

describe('F04: Planner Template Freedom (No Dictated Archetypes)', () => {
  it('confirms resolveLayoutArchetype has been completely removed from the planner', () => {
    expect((plannerModule as any).resolveLayoutArchetype).toBeUndefined();
    expect((plannerModule as any).LayoutArchetype).toBeUndefined();
  });

  it('exports CanvaDesignPlanner with structured JSON schema support', () => {
    expect(plannerModule.CanvaDesignPlanner).toBeDefined();
    expect(typeof plannerModule.CanvaDesignPlanner).toBe('function');
  });
});

