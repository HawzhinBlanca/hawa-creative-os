import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creativeAssetPath, studioReferenceFromRaw } from '@hawa/creative';
import type { Database, Kysely } from '@hawa/db';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import { GRAMMAR_PALETTE, grammarFixture } from '../../../packages/creative/test/fixtures/page-grammar.js';

const files = vi.hoisted(() => ({ reference: '', read: vi.fn() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: files.read.mockImplementation(actual.readFile) };
});
const original = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8')) as {
  clientId: string; rules: Record<string, unknown>;
};
const db = {} as Kysely<Database>; // The packaged path must return before querying a database.
const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: 'synthetic-grammar-control' };

describe('optional page grammar at the actual client reference boundary', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    files.read.mockReset().mockImplementation((...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === creativeAssetPath('kaae-reference.json')) return Promise.resolve(files.reference);
      return actual.readFile(...args);
    });
  });
  afterEach(() => vi.clearAllMocks());

  function reference(grammar?: unknown, present = true) {
    const ref = structuredClone(original);
    ref.rules.palette = [...GRAMMAR_PALETTE];
    if (present) ref.rules.pageGrammar = grammar;
    else delete ref.rules.pageGrammar;
    files.reference = JSON.stringify(ref);
    return ref;
  }

  it.each([
    ['empty nested members', () => Object.fromEntries(Object.keys(grammarFixture()).filter(k => k !== 'source').map(k => [k, {}])), 'pageGrammar.page.background'],
    ['empty gradient', () => { const g = grammarFixture(); g.header.accent.stops = []; return g; }, 'pageGrammar.header.accent.stops'],
    ['nonnumeric geometry', () => { const g: Record<string, unknown> = grammarFixture();
      g.header = { ...grammarFixture().header, accent: { ...grammarFixture().header.accent, widthShare: 'not-a-number' } }; return g; },
      'pageGrammar.header.accent.widthShare'],
  ] as const)('refuses %s before composition or provider work', async (_name, make, field) => {
    const ref = reference(make());
    await expect(resolveClientDesignReference(db, scope, original.clientId)).rejects.toMatchObject({
      status: 422, code: 'PAGE_GRAMMAR_INVALID', message: expect.stringContaining(field),
    });
    expect(() => studioReferenceFromRaw(ref)).toThrow('PAGE_GRAMMAR_INVALID');
    expect(files.read.mock.calls.every(call => String(call[0]) === creativeAssetPath('kaae-reference.json'))).toBe(true);
  });

  it('retains valid reference bytes and independent logo identity', async () => {
    const ref = reference(grammarFixture());
    const resolved = await resolveClientDesignReference(db, scope, original.clientId);
    expect(JSON.stringify(resolved.reference)).toBe(files.reference);
    expect(resolved.logo).toEqual(readFileSync(creativeAssetPath('logos/kaae-official-logo.png')));
    expect(studioReferenceFromRaw(ref).palette).toEqual(GRAMMAR_PALETTE);
  });

  it('keeps references without a grammar compatible', async () => {
    const ref = reference(undefined, false);
    expect((await resolveClientDesignReference(db, scope, original.clientId)).reference).toEqual(ref);
    expect(studioReferenceFromRaw(ref).palette).toEqual(GRAMMAR_PALETTE);
  });
});
