// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/components/CommandPalette.js';
import { clearAuthToken, setAuthToken } from '../src/services/auth.js';
import { advance, click, json, mount } from './support/desk-harness.js';

let view: Awaited<ReturnType<typeof mount>> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  setAuthToken('hawa_sess_palette_test');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  await view?.unmount(); view = undefined;
  clearAuthToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function query(value: string) {
  const input = view!.container.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await advance(200);
}
function PaletteHarness() {
  const [client, setClient] = useState('client-a');
  return React.createElement(React.Fragment, null,
    React.createElement('button', { onClick: () => setClient('client-b') }, 'Switch client'),
    React.createElement(CommandPalette, { isOpen: true, activeClientId: client, onClose() {}, onNavigate() {} }));
}

it('authenticates search and ignores a late result after the selected client changes', async () => {
  let answerA!: (res: Response) => void;
  const requests: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    requests.push(init);
    return url.includes('client-a') ? new Promise<Response>(resolve => { answerA = resolve; })
      : Promise.resolve(json({ results: [{ id: 'b', title: 'Current client result', category: 'TASKS' }] }));
  }));
  view = await mount(React.createElement(PaletteHarness));
  await query('poster');
  expect(new Headers(requests[0].headers).get('Authorization')).toBe('Bearer hawa_sess_palette_test');
  await click(view.container.querySelector('button'));
  await advance(200);
  expect(requests[0].signal?.aborted).toBe(true);
  expect(view.text()).toContain('Current client result');
  await act(async () => { answerA(json({ results: [{ id: 'a', title: 'Obsolete client result', category: 'TASKS' }] })); });
  expect(view.text()).toContain('Current client result');
  expect(view.text()).not.toContain('Obsolete client result');
});

it('shows a failed search instead of presenting it as no matches', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
  view = await mount(React.createElement(PaletteHarness));
  await query('poster');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Client search could not load');
});

it('does not retrieve without a selected client and does not offer unsupported templates', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  view = await mount(React.createElement(CommandPalette, { isOpen: true, onClose() {}, onNavigate() {} }));
  expect(view.text()).toContain('Select a task in Work');
  expect(view.text()).not.toContain('Clinical Podium');
  await query('poster');
  expect(fetch).not.toHaveBeenCalled();
});

// Bug hunt 2026-09-29, gap 2: a hit shown on no Desk page (Core answers url: null) used to open the
// generic review page. It is listed as such, and selecting it keeps the palette open.
it('lists a hit with no Desk page as such and opens nothing for it; says when older tasks were not searched', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ truncated: true, results: [
    { id: 'asset-1', title: 'Gala logo.png', subtitle: 'image/png · 2048 B', category: 'ASSETS', url: null },
  ] })));
  const onClose = vi.fn();
  const before = window.location.hash;
  view = await mount(React.createElement(CommandPalette, { isOpen: true, activeClientId: 'client-a', onClose, onNavigate() {} }));
  await query('gala');
  expect(view.text()).toContain('Gala logo.png');
  expect(view.text()).toContain('Not shown on a Desk page');
  expect(view.container.querySelector('[role="status"]')?.textContent).toContain('There are more matching tasks');
  await click(view.container.querySelector('#cmd-item-asset-1'));
  expect(onClose).not.toHaveBeenCalled();
  expect(window.location.hash).toBe(before);
});

it('names the client, exposes keyboard selection and returns focus when closed', async () => {
  const caller=document.createElement('button'); document.body.append(caller); caller.focus();
  view=await mount(React.createElement(CommandPalette,{isOpen:true,activeClientId:'client-a',activeClientName:'KAAE',onClose(){},onNavigate(){}}));
  await advance(100);
  const input=view.container.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute('aria-controls')).toBe('command-palette-results');
  expect(view.text()).toContain('KAAE');
  const before=input.getAttribute('aria-activedescendant');
  await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
  expect(input.getAttribute('aria-activedescendant')).not.toBe(before);
  expect(view.container.querySelector('[aria-selected="true"]')?.id).toBe(input.getAttribute('aria-activedescendant'));
  await view.unmount();view=undefined;expect(document.activeElement).toBe(caller);caller.remove();
});
