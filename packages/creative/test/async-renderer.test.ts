import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

describe('Task 5: Async Non-Blocking Layout Renderer (renderLayoutV2Async)', () => {
  it('proves renderLayoutV2Async is exported from @hawa/creative', async () => {
    const creative = await import('../src/index.js');
    expect(typeof (creative as any).renderLayoutV2Async).toBe('function');
  });

  it('proves production stages use renderLayoutV2Async instead of blocking renderLayoutV2', () => {
    const renderStage = fs.readFileSync(path.resolve(rootDir, 'apps/core/src/services/design-studio/stages/render.stage.ts'), 'utf8');
    expect(renderStage).toContain('renderLayoutV2Async');
    expect(renderStage).not.toMatch(/\brenderLayoutV2\(/);

    const canaryStage = fs.readFileSync(path.resolve(rootDir, 'apps/core/src/services/design-studio/stages/canary.stage.ts'), 'utf8');
    expect(canaryStage).toContain('renderLayoutV2Async');
    expect(canaryStage).not.toMatch(/\brenderLayoutV2\(/);

    const reviseStage = fs.readFileSync(path.resolve(rootDir, 'apps/core/src/services/design-studio/stages/revise.stage.ts'), 'utf8');
    expect(reviseStage).toContain('renderLayoutV2Async');
    expect(reviseStage).not.toMatch(/\brenderLayoutV2\(/);
  });

  it('renders a layout asynchronously without blocking event loop', async () => {
    const { renderLayoutV2Async, renderLayoutV2 } = await import('../src/index.js');
    const { LATIN_LAYOUT, LATIN_COPY } = await import('../../../scripts/render_studio_v2_proofs.js');

    let tickFired = false;
    setImmediate(() => {
      tickFired = true;
    });

    const resAsync = await renderLayoutV2Async(LATIN_LAYOUT, {
      copyText: LATIN_COPY,
    });

    expect(resAsync.svg).toContain('<svg');
    expect(Buffer.isBuffer(resAsync.png)).toBe(true);
    expect(resAsync.png.length).toBeGreaterThan(10000);
    expect(Buffer.isBuffer(resAsync.noTextPng)).toBe(true);
    expect(typeof resAsync.fontFidelity).toBe('object');
    expect(tickFired).toBe(true);

    const resSync = renderLayoutV2(LATIN_LAYOUT, { copyText: LATIN_COPY });
    expect(resAsync.svg).toBe(resSync.svg);
    expect(resAsync.wrappedLines).toEqual(resSync.wrappedLines);
  });
});
