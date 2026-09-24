// @vitest-environment jsdom
import React, { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorInspector } from '../src/components/VectorInspector.js';
import { AuthorizedImage } from '../src/components/AuthorizedImage.js';
import { authorizedImageEntries } from '../src/services/authorizedImage.js';
import { clearAuthToken, setAuthToken } from '../src/services/auth.js';
import { mount, stubCore } from './support/desk-harness.js';

/**
 * ADR-035: pictures are signed-in Core addresses (a task's export, a studio candidate, a reference
 * photo), and an <img src> sends no Authorization header. The Desk fetches them with the session's
 * header and shows an object URL; the service worker keeps them out of Cache Storage.
 */

const h = React.createElement;
const PREVIEW = '/v1/tasks/00000000-0000-4000-8000-000000000001/exports/00000000-0000-4000-8000-0000000000e1/content';
const token = ['desk', 'session', 'fixture'].join('_');

let created = 0;
let revoked: string[] = [];

beforeEach(() => {
  created = 0;
  revoked = [];
  setAuthToken(token);
  // jsdom has no object URLs; these stand in for the browser's.
  (URL as any).createObjectURL = vi.fn(() => `blob:desk/${++created}`);
  (URL as any).revokeObjectURL = vi.fn((u: string) => revoked.push(u));
});
afterEach(() => {
  clearAuthToken();
  vi.unstubAllGlobals();
});

const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200, headers: { 'Content-Type': 'image/png' } });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('the Desk shows signed-in pictures through the authorised hook', () => {
  it('VectorInspector fetches the preview with the session header and shows it as an object URL', async () => {
    const seen: Array<{ path: string; auth?: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ path: new URL(String(input), 'http://desk.test').pathname, auth: new Headers(init?.headers).get('Authorization') });
      return png();
    }));
    const view = await mount(h(VectorInspector, { previewUrl: PREVIEW, title: 'Recorded export' }));
    await settle();
    expect(seen).toEqual([{ path: PREVIEW, auth: `Bearer ${token}` }]);
    const img = view.container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('blob:desk/1');
    expect(img?.getAttribute('alt')).toBe('Recorded export');
    await view.unmount();
    expect(revoked).toEqual(['blob:desk/1']);
    expect(authorizedImageEntries()).toBe(0);
  });

  it('one fetch for the same address however many components show it; revoked when the last one goes', async () => {
    const calls = stubCore(() => png());
    const a = await mount(h(AuthorizedImage, { src: PREVIEW, alt: 'a' }));
    const b = await mount(h(AuthorizedImage, { src: PREVIEW, alt: 'b' }));
    await settle();
    expect(calls.filter((c) => c.path === PREVIEW)).toHaveLength(1);
    expect(a.container.querySelector('img')?.getAttribute('src')).toBe('blob:desk/1');
    expect(b.container.querySelector('img')?.getAttribute('src')).toBe('blob:desk/1');
    await a.unmount();
    expect(revoked).toEqual([]);
    await b.unmount();
    expect(revoked).toEqual(['blob:desk/1']);
  });

  it('says the preview could not be loaded when Core refuses it (404, signed out), and never shows a broken <img>', async () => {
    stubCore(() => new Response('{"title":"Not Found"}', { status: 404 }));
    const view = await mount(h(VectorInspector, { previewUrl: PREVIEW }));
    await settle();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.text()).toContain('Preview could not be loaded');
    await view.unmount();
  });

  it('passes a data: URL through without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const view = await mount(h(VectorInspector, { previewUrl: 'data:image/png;base64,iVBORw0KGgo=' }));
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(fetchSpy).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('StudioPanel draws every candidate picture through <AuthorizedImage>, never a bare <img>', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/components/StudioPanel.tsx'), 'utf8');
    expect(source).not.toMatch(/<img\b/);
    expect((source.match(/<AuthorizedImage\b/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the service worker keeps pictures out of Cache Storage', () => {
  /** sw.js run in a sandbox with a fake worker scope, returning its fetch handler and caches. */
  function loadWorker() {
    const handlers: Record<string, (event: any) => void> = {};
    const puts: string[] = [];
    const cache = { match: async () => undefined, put: async (req: Request) => { puts.push(new URL(req.url).pathname); } };
    const sandbox: any = {
      self: { addEventListener: (type: string, fn: any) => { handlers[type] = fn; }, location: { origin: 'https://desk.test' } },
      caches: { open: async () => cache },
      fetch: async () => new Response('x', { status: 200 }),
      URL,
      Response,
      console,
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8'), sandbox);
    return { onFetch: handlers.fetch, puts, sandbox };
  }

  it('answers export content, reference files and PNGs from the network only; JSON reads are still cached', async () => {
    const { onFetch, puts, sandbox } = loadWorker();
    for (const p of [
      PREVIEW,
      '/v1/tasks/00000000-0000-4000-8000-000000000001/files/' + 'a'.repeat(64),
      '/v1/tasks/t/canva/studio/r/candidates/c/preview/' + 'b'.repeat(64) + '.png',
      '/v1/comparisons/s/pairs/p/hawa.png',
    ]) {
      const respondWith = vi.fn();
      onFetch({ request: new Request(`https://desk.test${p}`), respondWith });
      expect(respondWith, p).not.toHaveBeenCalled();
      expect(sandbox.isBinaryApiPath(p), p).toBe(true);
    }
    const respondWith = vi.fn(async (r: Promise<Response>) => r);
    onFetch({ request: new Request('https://desk.test/v1/tasks/t'), respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
    await respondWith.mock.results[0].value;
    await new Promise((r) => setTimeout(r, 0));
    expect(puts).toEqual(['/v1/tasks/t']);
  });
});
