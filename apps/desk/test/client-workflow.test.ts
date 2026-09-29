// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { DnaScreen } from '../src/screens/DnaScreen.js';
import { DeskProviders, createDeskRuntime, type DeskRuntime } from '../src/DeskProviders.js';
import { setAuthToken, clearAuthToken } from '../src/services/auth.js';
import { submitManualTask } from '../src/services/manualTaskIntake.js';
import { draftStore } from '../src/services/draftStore.js';
import { i18nManager } from '../src/services/i18n.js';
import { FakeStream, advance, byText, click, json, mount, stubCore } from './support/desk-harness.js';

const a = 'aa000000-0000-4000-8000-000000000001';
const b = 'bb000000-0000-4000-8000-000000000002';
const summary = (id: string, name: string) => ({ clientId: id, name, code: name, version: 1,
  status: 'active', defaultLocale: 'en', defaultDirection: 'ltr', colorsCount: 0, rulesCount: 0 });
const clients = [summary(a, 'Orchid Books'), summary(b, 'Cedar Bakery')];
const dna = (id: string, name: string) => ({ ...summary(id, name), tenantId: 'office', colors: [], fonts: [], assets: [],
  guidelines: { layoutRules: [], imageryRules: [], toneOfVoice: [], forbiddenElements: [], requiredElements: [] },
  languageRules: { preferredTerminology: {}, prohibitedPhrases: [], requiredDisclaimers: [] } });
let view: Awaited<ReturnType<typeof mount>> | undefined;
let runtime: DeskRuntime | undefined;
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); setAuthToken('hawa_sess_client_test'); });
afterEach(async () => {
  await view?.unmount(); await runtime?.queryClient.cancelQueries(); runtime?.queryClient.clear();
  i18nManager.setLocale('en');
  vi.useRealTimers(); vi.unstubAllGlobals(); clearAuthToken(); localStorage.clear(); window.location.hash = '';
  view = undefined; runtime = undefined;
});
async function renderApp() {
  runtime = createDeskRuntime({ stream: new FakeStream(), doc: { hidden: false } });
  view = await mount(React.createElement(DeskProviders, { runtime, children: React.createElement(App) }));
  await advance(500);
  await click(byText(view.container, 'button', /New task/i));
  await advance(500);
  return view;
}
function common(path: string) {
  if (path === '/v1/auth/session') return json({ authenticated: true, user: { id: 'u', role: 'operator' } });
  if (path === '/v1/tasks') return json({ items: [], total: 0 });
  if (path === '/v1/health') return json({ status: 'ok' });
}

describe('registered client workflow', () => {
  it('opens the exact client named by a search link instead of the first client', async () => {
    window.location.hash = `#/dna?client=${b}`;
    const calls = stubCore(c => c.path === '/v1/clients' ? json(clients)
      : c.path === `/v1/clients/${b}/dna` ? json(dna(b, 'Cedar Bakery'))
      : c.path.endsWith('/snapshots') ? json([])
      : c.path.endsWith('/candidate-rules') ? json({candidateRules:[]}) : common(c.path));
    runtime = createDeskRuntime({ stream: new FakeStream(), doc: {hidden:false} });
    view = await mount(React.createElement(DeskProviders, {runtime, children:React.createElement(App)}));
    await advance(500);
    expect(view.text()).toContain(b);
    expect(calls.some(c => c.path === `/v1/clients/${a}/dna`)).toBe(false);
  });
  it('does not open a different client when a search link is unavailable', async () => {
    stubCore(c => c.path === '/v1/clients' ? json([clients[0]]) : undefined);
    view = await mount(React.createElement(DnaScreen, {initialClientId:b}));
    await advance(200);
    expect(view.text()).toContain('The linked client is unavailable');
    expect(view.container.querySelector('.listitem.active')).toBeNull();
  });
  it('scopes command search to the selected Work task and runs the tour and language actions', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable:true,value:vi.fn()});
    const calls = stubCore(c => c.path === '/v1/tasks' ? json({items:[{id:'task-a',title:'Searchable task',status:'CREATED',clientId:a,version:1}],total:1})
      : c.path === '/v1/search' ? json({results:[]}) : common(c.path));
    runtime = createDeskRuntime({ stream:new FakeStream(),doc:{hidden:false} });
    view = await mount(React.createElement(DeskProviders, {runtime,children:React.createElement(App)}));
    await advance(500);
    const openPalette = async () => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); }); await advance(100); };
    await openPalette();
    await act(async () => {
      const input = view!.container.querySelector<HTMLInputElement>('#command-palette-input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'poster');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await advance(200);
    expect(calls.find(c => c.path === '/v1/search')?.search.get('clientId')).toBe(a);
    await openPalette(); await openPalette();
    await click(view.container.querySelector('#cmd-item-act-kurdish'));
    expect(i18nManager.getLocale()).toBe('ckb');
    await openPalette();
    await click(view.container.querySelector('#cmd-item-act-tour'));
    expect(view.text()).toContain('Your work queue');
  });
  it('keeps a saving form open and prevents edits until the original result returns', async () => {
    let answer!: (response: Response) => void;
    stubCore(c => c.path === '/v1/clients' ? json(clients)
      : c.path === '/v1/tasks' && c.method === 'POST' ? new Promise<Response>(resolve => { answer = resolve; }) : common(c.path));
    draftStore.saveActiveDraft({title:'Original request',copy:'Exact copy',clientId:a});
    const screen = await renderApp();
    await click(byText(screen.container, 'button', 'Save request'));
    await act(async () => { screen.container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); });
    expect(screen.container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(screen.container.querySelector<HTMLInputElement>('#modal-task-title')!.disabled).toBe(true);
    expect(screen.container.querySelector<HTMLTextAreaElement>('#modal-copy-en')!.disabled).toBe(true);
    await act(async () => { answer(json({id:'saved-original'})); }); await advance(200);
    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
    expect(draftStore.getActiveDraft()).toBeNull();
  });
  it('opens a recoverable error state without deleting a damaged retry record', async () => {
    stubCore(c => c.path === '/v1/clients' ? json(clients) : common(c.path));
    localStorage.setItem('hawa_desk_pending_manual_intake_v1', '{damaged');
    const screen = await renderApp();
    expect(screen.container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(screen.text()).toMatch(/retry record.*cannot be read/i);
    expect((byText(screen.container,'button','Save request') as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('hawa_desk_pending_manual_intake_v1')).toBe('{damaged');
  });
  it('preserves a damaged active draft instead of autosaving an empty replacement', async () => {
    stubCore(c => c.path === '/v1/clients' ? json(clients) : common(c.path));
    localStorage.setItem('hawa_desk_active_draft', '{damaged');
    const screen = await renderApp();
    expect(screen.text()).toMatch(/saved draft cannot be read/i);
    expect((byText(screen.container,'button','Save request') as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('hawa_desk_active_draft')).toBe('{damaged');
  });
  it('disables an unchanged retry when the office session ends', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('lost')));
    await expect(submitManualTask({title:'Uncertain request',copy:'Exact words',clientId:a})).rejects.toThrow('unconfirmed');
    stubCore(c => c.path === '/v1/clients' ? json(clients) : common(c.path));
    const screen = await renderApp();
    expect((byText(screen.container,'button','Save request') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { runtime!.session.end('Session ended'); });
    expect((byText(screen.container,'button','Save request') as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('hawa_desk_pending_manual_intake_v1')).toContain('Uncertain request');
  });
  it('loads actual clients and requires an explicit choice for a new request', async () => {
    stubCore(c => c.path === '/v1/clients' ? json(clients) : common(c.path));
    const screen = await renderApp();
    const select = screen.container.querySelector<HTMLSelectElement>('#modal-client-select')!;
    expect([...select.options].map(o => o.text)).toEqual(['Choose a client', 'Orchid Books', 'Cedar Bakery']);
    expect(select.value).toBe('');
    expect((byText(screen.container, 'button', 'Save request') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.text()).not.toContain('KAAE (Kurdistan');
  });
  it('preserves an unavailable draft client and refuses to silently choose another', async () => {
    draftStore.saveActiveDraft({ title: 'Saved draft', copy: 'Exact text', clientId: b });
    stubCore(c => c.path === '/v1/clients' ? json([clients[0]]) : common(c.path));
    const screen = await renderApp();
    expect(screen.text()).toContain('The saved client is unavailable');
    expect(screen.container.querySelector<HTMLSelectElement>('#modal-client-select')!.value).toBe(b);
    expect((byText(screen.container, 'button', 'Save request') as HTMLButtonElement).disabled).toBe(true);
    expect(draftStore.getActiveDraft()?.clientId).toBe(b);
  });
  it('offers retry and keeps creation blocked if the client directory cannot be read', async () => {
    stubCore(c => c.path === '/v1/clients' ? json({ detail: 'Directory unavailable' }, 503) : common(c.path));
    const screen = await renderApp(); await advance(5000);
    expect(screen.text()).toContain('Client list unavailable');
    expect(byText(screen.container, 'button', 'Retry client list')).toBeTruthy();
    expect((byText(screen.container, 'button', 'Save request') as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows every registered brand and ignores the previous client response after switching', async () => {
    let answerA!: (response: Response) => void;
    const calls = stubCore(c => {
      if (c.path === '/v1/clients') return json(clients);
      if (c.path === `/v1/clients/${a}/dna`) return new Promise<Response>(resolve => { answerA = resolve; });
      if (c.path === `/v1/clients/${b}/dna`) return json(dna(b, 'Cedar Bakery'));
      if (c.path.endsWith('/snapshots')) return json([]);
      if (c.path.endsWith('/candidate-rules')) return json({ candidateRules: [] });
    });
    view = await mount(React.createElement(DnaScreen)); await advance(200);
    expect(view.text()).toContain('Orchid Books'); expect(view.text()).toContain('Cedar Bakery');
    await click(byText(view.container, '.listitem', 'Cedar Bakery')); await advance(200);
    await act(async () => { answerA(json(dna(a, 'ORCHID OLD RESPONSE'))); }); await advance(200);
    expect(view.text()).not.toContain('ORCHID OLD RESPONSE');
    expect(view.text()).toContain(b);
    expect(calls.some(c => c.path.includes('c1000000-0000-4000-8000-000000000002'))).toBe(false);
  });
});


describe('client changes during pending work', () => {
  it('recovers an unconfirmed original-client save even when that client left the directory', async () => {
    const draft = { title: 'Frozen request', copy: 'Exact original text', clientId: b };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('lost')));
    await expect(submitManualTask(draft)).rejects.toThrow('unconfirmed');
    const calls = stubCore(c => {
      if (c.path === '/v1/clients') return json([clients[0]]);
      if (c.path === '/v1/tasks' && c.method === 'POST') return json({ id: 'recovered', clientId: b });
      return common(c.path);
    });
    const screen = await renderApp();
    expect(screen.text()).toContain('earlier save is unconfirmed');
    expect(screen.container.querySelector<HTMLSelectElement>('#modal-client-select')!.disabled).toBe(true);
    const save = byText(screen.container, 'button', 'Save request') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await click(save); await advance(200);
    expect(calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([
      expect.objectContaining({ clientId: b, title: draft.title, copyEn: draft.copy }),
    ]);
  });
  it('a delayed brand save cannot overwrite the newly selected client or its editor controls', async () => {
    let answerSave!: (response: Response) => void;
    const calls = stubCore(c => {
      if (c.path === '/v1/clients') return json(clients);
      if (c.path === `/v1/clients/${a}/dna` && c.method === 'POST') return new Promise<Response>(resolve => { answerSave = resolve; });
      if (c.path === `/v1/clients/${a}/dna`) return json(dna(a, 'Orchid Books'));
      if (c.path === `/v1/clients/${b}/dna`) return json(dna(b, 'Cedar Bakery'));
      if (c.path.endsWith('/snapshots')) return json([]);
      if (c.path.endsWith('/candidate-rules')) return json({ candidateRules: [] });
    });
    view = await mount(React.createElement(DnaScreen)); await advance(200);
    await click(byText(view.container, 'button', '+ Add Swatch'));
    await act(async () => {
      const input = view!.container.querySelector<HTMLInputElement>('#dna-new-swatch-name')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Original brand accent');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText(view.container, 'button', /^Add Swatch$/));
    await click(byText(view.container, '.listitem', 'Cedar Bakery')); await advance(200);
    await act(async () => { answerSave(json({ ...dna(a, 'ORCHID SAVED LATE'), version: 2 })); }); await advance(200);
    expect(view.text()).not.toContain('ORCHID SAVED LATE');
    expect(view.text()).not.toContain('Original brand accent');
    expect(view.text()).toContain(b);
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([`/v1/clients/${a}/dna`]);
  });
});

it('opens the task form and changes routes when Core becomes unavailable, preserving the draft',async()=>{
 let unavailable=false;
 stubCore(c=>unavailable ? json({detail:'Core unavailable'},503) : c.path==='/v1/clients'?json(clients):common(c.path));
 draftStore.saveActiveDraft({title:'Retained office request',copy:'Exact text',clientId:a});
 window.location.hash='#/ops';
 const screen=await renderApp();
 expect(screen.container.querySelector('[role="dialog"]')).toBeTruthy();
 expect(screen.container.querySelector<HTMLInputElement>('#modal-task-title')?.value).toBe('Retained office request');
 await click(byText(screen.container,'button','Cancel'));unavailable=true;
 await click(screen.container.querySelector('#nav-work'));await advance(500);
 expect(window.location.hash).toBe('#/work');
 await click(byText(screen.container,'button',/New task/i));await advance(5000);
 expect(screen.container.querySelector('[role="dialog"]')).toBeTruthy();expect(screen.text()).toContain('Client list unavailable');
 expect(screen.container.querySelector<HTMLInputElement>('#modal-task-title')?.value).toBe('Retained office request');
 expect((byText(screen.container,'button','Save request') as HTMLButtonElement).disabled).toBe(true);
 expect(screen.container.querySelector('#omnisearch-btn')?.getAttribute('aria-label')).toContain('Search');
});
