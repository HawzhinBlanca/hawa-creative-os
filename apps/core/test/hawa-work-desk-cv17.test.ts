import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('CV-17: Lean Hawa Work Desk Architecture & Contract Tests', () => {
  const deskSrc = path.resolve(__dirname, '../../desk/src');

  it('verifies WorkScreen component implements all 5 primary actions (FR-078)', () => {
    const workScreenPath = path.join(deskSrc, 'screens/WorkScreen.tsx');
    expect(fs.existsSync(workScreenPath)).toBe(true);

    const content = fs.readFileSync(workScreenPath, 'utf8');

    // 1. Edit in Canva
    expect(content).toContain('handleEditInCanva');
    expect(content).toContain('btn-edit-in-canva');
    expect(content).toContain('Edit in Canva');

    // 2. Capture for review
    expect(content).toContain('handleCaptureForReview');
    expect(content).toContain('btn-capture-for-review');
    expect(content).toContain('Capture for Review');

    // 3. Request revision
    expect(content).toContain('btn-request-revision');
    expect(content).toContain('handleSendRevisionRequest');
    expect(content).toContain('Request Revision');

    // 4. Approve captured files
    expect(content).toContain('handleApprove');
    expect(content).toContain('btn-approve-captured');
    expect(content).toContain('Approve Captured Files');

    // 5. Deliver approved files
    expect(content).toContain('handleDeliver');
    expect(content).toContain('btn-deliver-approved');
    expect(content).toContain('Deliver Approved Files');
  });

  it('verifies large captured preview with metadata and checksums (FR-077, FR-032)', () => {
    const workScreenPath = path.join(deskSrc, 'screens/WorkScreen.tsx');
    const content = fs.readFileSync(workScreenPath, 'utf8');

    expect(content).toContain('preview-stage-container');
    expect(content).toContain('preview-viewport');
    expect(content).toContain('preview-meta-strip');
    expect(content).toContain('SHA-256 Checksum');
    expect(content).toContain('btn-copy-hash');
    expect(content).toContain('Aspect Ratio');
  });

  it('verifies exact copy invariants and Kurdish typography bidi isolation (FR-006, NFR-022)', () => {
    const workScreenPath = path.join(deskSrc, 'screens/WorkScreen.tsx');
    const content = fs.readFileSync(workScreenPath, 'utf8');

    expect(content).toContain('exact-copy-notice');
    expect(content).toContain('Exact Copy Invariant (#1)');
    expect(content).toContain('<SubmittedCopy');

    // The copy blocks themselves are drawn by SubmittedCopy.
    const copyPanel = fs.readFileSync(path.join(deskSrc, 'components/SubmittedCopy.tsx'), 'utf8');
    expect(copyPanel).toContain('kurdish-typeset');
    expect(copyPanel).toContain('bidi-isolated');
    expect(copyPanel).toContain('dir="rtl"');
  });

  it('verifies route and navigation replacement matrix (FR-064)', () => {
    const sidebarPath = path.join(deskSrc, 'components/Sidebar.tsx');
    const appPath = path.join(deskSrc, 'App.tsx');
    expect(fs.existsSync(sidebarPath)).toBe(true);
    expect(fs.existsSync(appPath)).toBe(true);

    const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
    const appContent = fs.readFileSync(appPath, 'utf8');

    // Primary 3 navigation tabs in Sidebar
    expect(sidebarContent).toContain('nav-work');
    expect(sidebarContent).toContain('nav-clients');
    expect(sidebarContent).toContain('nav-settings');

    // Backward-compatible screen mapping
    expect(appContent).toContain("currentScreen === 'work'");
    expect(appContent).toContain("currentScreen === 'inbox'");
    expect(appContent).toContain("currentScreen === 'review'");
    expect(appContent).toContain("currentScreen === 'clients'");
    expect(appContent).toContain("currentScreen === 'dna'");
    expect(appContent).toContain("currentScreen === 'library'");
    expect(appContent).toContain("currentScreen === 'settings'");

    // No Polotno editor rendered in primary review flow
    expect(appContent).not.toContain('<ReviewScreen task={selectedTask} />');
  });

  it('verifies honest health replaces fake health indicators (FR-064)', () => {
    const sidebarPath = path.join(deskSrc, 'components/Sidebar.tsx');
    const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');

    // Probes /v1/health instead of static hardcoded string
    expect(sidebarContent).toContain('fetch(\'/v1/health\'');
    expect(sidebarContent).toContain('probeHealth');
    expect(sidebarContent).toContain('healthStatus');
  });

  it('verifies accessibility, focus-visible, and responsive CSS (FR-076, NFR-004, NFR-021)', () => {
    const cssPath = path.join(deskSrc, 'index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Visible focus ring
    expect(cssContent).toContain(':focus-visible');

    // Responsive breakpoints
    expect(cssContent).toContain('@media (max-width: 1040px)');
    expect(cssContent).toContain('@media (max-width: 768px)');
    expect(cssContent).toContain('@media (max-width: 390px)');

    // Reduced motion support
    expect(cssContent).toContain('@media (prefers-reduced-motion: reduce)');

    // Contrast compliant status pills
    expect(cssContent).toContain('.pill-action');
    expect(cssContent).toContain('.pill-approved');
    expect(cssContent).toContain('.pill-complete');
  });

  it('verifies bundle optimization metrics (< 500kB JS)', () => {
    const deskDist = path.resolve(__dirname, '../../desk/dist/assets');
    expect(fs.existsSync(deskDist)).toBe(true);

    // The budget is for the entry chunk index.html loads. Since ADR-037 the secondary screens are
    // separate chunks loaded on first visit, so "the first .js file in the folder" is no longer it.
    const indexHtml = fs.readFileSync(path.resolve(deskDist, '../index.html'), 'utf8');
    const entry = /<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/.exec(indexHtml)?.[1];
    expect(entry).toBeDefined();

    const jsStat = fs.statSync(path.join(deskDist, entry!));
    // Size must be less than 500 KB (previously ~2,000 KB)
    expect(jsStat.size).toBeLessThan(500 * 1024);
    expect(jsStat.size).toBeGreaterThan(100 * 1024);

    // No lazily loaded chunk may exceed the budget either.
    for (const f of fs.readdirSync(deskDist).filter((name) => name.endsWith('.js'))) {
      expect(fs.statSync(path.join(deskDist, f)).size).toBeLessThan(500 * 1024);
    }
  });
});
