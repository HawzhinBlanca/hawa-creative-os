import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderLayoutV2, renderLayoutV2Async, type StudioLayoutV2 } from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-tier-stroke-slab-brief_08.json', import.meta.url), 'utf8')
) as { copy: string[]; layout: StudioLayoutV2 };
const copyText = Object.fromEntries(fixture.copy.map((c, i) => [i, c]));

/** How many times a 5 ms timer fires while `work` runs: zero means the event loop was held. */
async function ticksDuring(work: () => Promise<unknown> | unknown): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try { await work(); } finally { clearInterval(timer); }
  return ticks;
}

describe('renderLayoutV2Async: the same render, without holding the event loop', () => {
  it('produces the same bytes as the synchronous renderer', async () => {
    const sync = renderLayoutV2(fixture.layout, { logoDataUri: KAAE_TEST_LOGO, copyText });
    const async_ = await renderLayoutV2Async(fixture.layout, { logoDataUri: KAAE_TEST_LOGO, copyText });
    expect(async_.svg).toBe(sync.svg);
    expect(async_.png.equals(sync.png)).toBe(true);
    expect(async_.noTextPng.equals(sync.noTextPng)).toBe(true);
    expect(async_.wrappedLines).toEqual(sync.wrappedLines);
  }, 60_000);

  it('lets timers run while it rasterises, where the synchronous renderer lets none', async () => {
    const blocked = await ticksDuring(() => renderLayoutV2(fixture.layout, { logoDataUri: KAAE_TEST_LOGO, copyText }));
    const free = await ticksDuring(() => renderLayoutV2Async(fixture.layout, { logoDataUri: KAAE_TEST_LOGO, copyText }));
    expect(blocked).toBe(0);
    expect(free).toBeGreaterThan(3);
  }, 60_000);

  it('rejects when the rasteriser fails', async () => {
    // A binary that exists and exits 1. (A path that does not exist falls back to the known locations.)
    await expect(renderLayoutV2Async(fixture.layout, { logoDataUri: KAAE_TEST_LOGO, copyText, rsvgConvertPath: '/usr/bin/false' })).rejects.toThrow(/rsvg-convert rendering failed/);
  }, 60_000);
});
