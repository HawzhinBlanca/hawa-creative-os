// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientModelConsentPanel } from '../src/components/ClientModelConsentPanel.js';
import { DnaScreen } from '../src/screens/DnaScreen.js';
import { clearAuthToken, setAuthToken } from '../src/services/auth.js';
import { advance, byText, click, json, mount, stubCore } from './support/desk-harness.js';

const clientId = 'aa000000-0000-4000-8000-000000000001';
const consent = { clientId, version: 4, approved: false, approvedBy: null, privacy: null, modelReading: { openai: false } };
let view: Awaited<ReturnType<typeof mount>> | undefined;
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); setAuthToken('hawa_sess_consent_test'); });
afterEach(async () => { await view?.unmount(); view = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); clearAuthToken(); });
async function input(selector: string, value: string) {
  await act(async () => {
    const field = view!.container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector)!;
    const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function panel(role = 'administrator', answer?: (body: any) => Response | Promise<Response>) {
  const calls = stubCore(c => c.path === '/v1/auth/session' ? json({ authenticated: true, user: { id: 'person', role } })
    : c.path.endsWith('/model-consent') ? c.method === 'GET' ? json(consent) : answer?.(c.body) : undefined);
  const onRecorded = vi.fn(async () => {});
  view = await mount(React.createElement(ClientModelConsentPanel, { clientId, onRecorded }));
  await advance(50);
  return { calls, onRecorded };
}
async function chooseAndSubmit() {
  await input('select', 'approved_providers');
  await input('textarea', 'Client approved OpenAI reading for this work.');
  await click(byText(view!.container, 'button', 'Record consent decision'));
  await advance(50);
}
it('shows an operator the real consent without offering a write', async () => {
  const { calls } = await panel('operator');
  expect(view!.text()).toContain('OpenAI reading off');
  expect(view!.text()).toContain('administrator');
  expect(view!.container.querySelector('form')).toBeNull();
  expect(calls.some(c => c.method === 'POST')).toBe(false);
});
it('requires an explicit administrator choice and reason bound to the read version', async () => {
  const { calls, onRecorded } = await panel('administrator', () => json({ clientId, version: 5, modelReading: { openai: true } }, 201));
  expect(calls.some(c => c.method === 'POST')).toBe(false);
  expect((view!.container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  expect((view!.container.querySelector('select') as HTMLSelectElement).value).toBe('local_only');
  await chooseAndSubmit();
  expect(calls.filter(c => c.method === 'POST').map(c => c.body)).toEqual([
    { expectedVersion: 4, mode: 'approved_providers', providers: ['openai'], reason: 'Client approved OpenAI reading for this work.' },
  ]);
  expect(onRecorded).toHaveBeenCalledOnce();
  expect(view!.text()).toContain('Consent recorded at brand version 5');
});
it('freezes an unconfirmed write and retries exactly the original request', async () => {
  let writes = 0;
  const { calls, onRecorded } = await panel('administrator', async () => {
    if (++writes === 1) throw new Error('connection lost');
    return json({ clientId, version: 5, modelReading: { openai: true } });
  });
  await chooseAndSubmit();
  expect(view!.text()).toContain('unconfirmed');
  expect(view!.container.querySelector('fieldset')!.disabled).toBe(true);
  expect(onRecorded).not.toHaveBeenCalled();
  await click(byText(view!.container, 'button', 'Retry unchanged consent request')); await advance(50);
  const bodies = calls.filter(c => c.method === 'POST').map(c => c.body);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(onRecorded).toHaveBeenCalledOnce();
});
it('does not silently rebase or retry a rejected stale consent write', async () => {
  const { calls } = await panel('administrator', () => json({ title: 'DNA_VERSION_CONFLICT', detail: 'Version moved' }, 409));
  await chooseAndSubmit();
  expect(view!.text()).toContain('Version moved');
  expect(byText(view!.container, 'button', 'Review current consent')).toBeTruthy();
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  await click(byText(view!.container, 'button', 'Review current consent')); await advance(50);
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
});
it('rejects a different-client consent read before offering any action', async () => {
  const calls = stubCore(c => c.path === '/v1/auth/session' ? json({ authenticated: true, user: { role: 'administrator' } })
    : c.path.endsWith('/model-consent') ? json({ ...consent, clientId: 'another-client' }) : undefined);
  view = await mount(React.createElement(ClientModelConsentPanel, { clientId, onRecorded: async () => {} })); await advance(50);
  expect(view.text()).toContain('different client'); expect(view.container.querySelector('form')).toBeNull();
  expect(calls.some(c => c.method === 'POST')).toBe(false);
});
it('shows the actual off reason after brand save and excludes status from the next save', async () => {
  let dna: any = { clientId, name: 'Orchid Books', code: 'orchid', tenantId: 'office', version: 1, status: 'active',
    colors: [{ name: 'Ink', hex: '#000000', role: 'text' }, { name: 'Canvas', hex: '#ffffff', role: 'background' }], fonts: [], assets: [], defaultLocale: 'en', defaultDirection: 'ltr',
    guidelines: { layoutRules: [], prohibitedPhrases: [], requiredDisclaimers: [] }, modelReading: { openai: true } };
  const calls = stubCore(c => c.path === '/v1/clients' ? json([{ ...dna, colorsCount: 1, rulesCount: 0 }])
    : c.path === `/v1/clients/${clientId}/dna` ? c.method === 'GET' ? json(dna) :
      (dna = { ...c.body, version: dna.version + 1, modelReading: { openai: false, reason: 'Only an office administrator keeps consent.' } }, json(dna))
    : c.path.endsWith('/snapshots') ? json([]) : c.path.endsWith('/candidate-rules') ? json({ candidateRules: [] }) : undefined);
  view = await mount(React.createElement(DnaScreen, { initialClientId: clientId })); await advance(50);
  await click(view.container.querySelector('button[aria-label="Remove Ink color"]')); await advance(50);
  expect(view.text()).toContain('Brand changes saved');
  expect(view.text()).toContain('Model reading is now off for this client');
  expect(view.text()).toContain('Only an office administrator keeps consent.');
  await click(byText(view.container, 'button', 'Undo color removal')); await advance(50);
  const writes = calls.filter(c => c.method === 'POST');
  expect(writes).toHaveLength(2); expect(writes[1].body.version).toBe(2);
  for (const call of writes) expect(call.body).not.toHaveProperty('modelReading');
});
