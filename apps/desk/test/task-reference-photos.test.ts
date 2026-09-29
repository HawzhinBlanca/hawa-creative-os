import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Production, 2026-09-29: a KAAE request opened from a six-photo Telegram album showed no client and
 * no reference photos. GET /tasks/:id now returns `clientName`, `referenceImages` (each with the
 * authorised /v1/tasks/:id/files/:sha256 address) and `referenceImageCount`
 * (apps/core/test/task-detail-client-and-photos.test.ts). The Work screen's Brief tab shows the count
 * from the detail, and each photo through <AuthorizedImage>, since an <img src> sends no session.
 * `referenceAssets` stays the free-text "Reference notes".
 */
const SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/screens/WorkScreen.tsx'), 'utf8');

describe('the Work screen\'s reference photos', () => {
  it('shows the detail\'s photo count, whatever the free-text reference notes say', () => {
    expect(SOURCE).toMatch(/typeof selectedTask\.referenceImageCount === 'number' &&/);
    expect(SOURCE).toMatch(/<h4>Reference photos: \{selectedTask\.referenceImageCount\}<\/h4>/);
    expect(SOURCE).toMatch(/<h4>Reference notes<\/h4><p style=\{\{whiteSpace:'pre-wrap'\}\}>\{selectedTask\.referenceAssets\}/);
  });

  it('draws each photo from its authorised address, with the short hash when it cannot be fetched', () => {
    const block = SOURCE.slice(SOURCE.indexOf('data-testid="reference-photos"'));
    expect(block).toMatch(/selectedTask\.referenceImages!\.map\(\(photo, i\) => \(\s*<AuthorizedImage\s+key=\{photo\.sha256\}\s+src=\{photo\.url\}/);
    expect(block).toMatch(/fallback=\{<span[^>]*>\{photo\.sha256\.slice\(0, 12\)\}<\/span>\}/);
    expect(SOURCE).toMatch(/import \{ AuthorizedImage \} from '\.\.\/components\/AuthorizedImage\.js';/);
  });

  it('shows the client name from the task', () => {
    expect(SOURCE).toMatch(/<span className="client-badge-large">\{selectedTask\.clientName \|\| 'Client'\}<\/span>/);
  });
});
