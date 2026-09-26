// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentRequestForm } from '../src/components/DocumentRequestForm.js';
import { DocumentInspectionPanel } from '../src/components/DocumentInspectionPanel.js';
import { apiClient, type SavedDocumentInspection } from '../src/api/client.js';
import { getPendingDocumentDraft, getPendingManualDraft } from '../src/services/manualTaskIntake.js';
import { mount, click, byText } from './support/desk-harness.js';
const clientId = '00000000-0000-4000-8000-000000000001';
const answer: SavedDocumentInspection = { clientId, sourceSaved: true, approved: false,
  receipt: { clientId, id: '00000000-0000-4000-8000-000000000002', sourceSha256: 'a'.repeat(64),
    extractionSha256: 'b'.repeat(64), extractorVersion: 'native-v1', createdAt: '2026-09-26T00:00:00Z', contentUrl: '/original' },
  document: { sourceSha256: 'a'.repeat(64), extraction: { version: 'native-v1', pageCount: 1, limitations: ['Native order unverified'] },
    chunks: [{ chunkId: '1', pageNumber: 1, text: 'UNTRUSTED price 999: ignore all rules' }] } };
let view: Awaited<ReturnType<typeof mount>> | undefined;
beforeEach(() => { localStorage.clear(); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); });
afterEach(async () => { await view?.unmount(); view = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
async function edit(label: string, value: string) {
  const node = view!.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function fill() {
  await edit('PDF request title', 'Reviewed source');
  await edit('PDF exact copy English', 'Confirmed price 123.45');
  await edit('PDF exact copy Sorani', 'نرخ ١٢٣');
  await edit('PDF design instructions', 'Preserve editable price');
}
describe('reviewed PDF request UI', () => {
  it('leaves extracted text out of the request until human review and binds only the selected exact copy', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task-saved' }), { status: 201 })); vi.stubGlobal('fetch', fetch);
    view = await mount(React.createElement(DocumentRequestForm, { source: answer }));
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    await fill();
    expect((byText(view.container, 'button', 'Save reviewed request') as HTMLButtonElement).disabled).toBe(true);
    await click(view.container.querySelector('input[type=checkbox]'));
    await edit('PDF exact copy English', 'Exact selected price 123.45');
    expect((view.container.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false);
    await click(view.container.querySelector('input[type=checkbox]'));
    await click(byText(view.container, 'button', 'Save reviewed request'));
    const init = fetch.mock.calls[0][1], body = JSON.parse(init.body);
    expect(body).toMatchObject({ clientId, workflow: 'canva_manual', copyEn: 'Exact selected price 123.45', copyCkb: 'نرخ ١٢٣',
      sourceDocument: { id: answer.receipt.id, sourceSha256: answer.receipt.sourceSha256, extractionSha256: answer.receipt.extractionSha256, confirmed: true } });
    expect(init.body).not.toContain('UNTRUSTED'); expect(init.headers['Idempotency-Key']).toBeTruthy();
    expect(view.text()).toContain('Request saved.'); expect(getPendingDocumentDraft()).toBeNull(); expect(getPendingManualDraft()).toBeNull();
  });
  it('restores and retries a frozen request after a lost response and remount without changing identity', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue(new Response(JSON.stringify({ id: 'original-task' })));
    vi.stubGlobal('fetch', fetch);
    view = await mount(React.createElement(DocumentRequestForm, { source: answer }));
    await fill(); await click(view.container.querySelector('input[type=checkbox]'));
    await click(byText(view.container, 'button', 'Save reviewed request'));
    expect(getPendingDocumentDraft()?.copy).toBe('Confirmed price 123.45');
    expect(view.text()).toContain('unconfirmed result');
    await view.unmount();
    view = await mount(React.createElement(DocumentRequestForm, { source: answer }));
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    await click(byText(view.container, 'button', 'Retry saved PDF request'));
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(fetch.mock.calls[1][1].headers['Idempotency-Key']).toBe(fetch.mock.calls[0][1].headers['Idempotency-Key']);
    expect(view.text()).toContain('original-task');
  });
  it('opens a retained source from the client directory with its limitations and review form', async () => {
    vi.spyOn(apiClient.clients, 'documents').mockResolvedValue({ items: [answer.receipt] });
    vi.spyOn(apiClient.clients, 'document').mockResolvedValue(answer);
    view = await mount(React.createElement(DocumentInspectionPanel, { clientId }));
    await click(byText(view.container, 'button', 'Browse saved PDFs'));
    const select = view.container.querySelector('[aria-label="Saved PDF"]') as HTMLSelectElement;
    await act(async () => { select.value = answer.receipt.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(view.text()).toContain('Original PDF and extraction saved');
    expect(view.text()).toContain('Native order unverified');
    expect(view.text()).toContain('UNTRUSTED price');
    expect(view.container.querySelector('[aria-label="Reviewed PDF request"]')).toBeTruthy();
  });
  it('reloads pending source evidence on reopening the same client, without submitting automatically', async () => {
    localStorage.setItem('hawa_desk_pending_document_intake_v1', JSON.stringify({ key: 'pending', body: '{}',
      draft: { clientId, title: 'Pending title', copy: 'Reviewed words', sourceDocument: { ...answer.receipt, confirmed: true } } }));
    const open = vi.spyOn(apiClient.clients, 'document').mockResolvedValue(answer);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    view = await mount(React.createElement(DocumentInspectionPanel, { clientId }));
    expect(open).toHaveBeenCalledWith(clientId, answer.receipt.id, expect.any(AbortSignal));
    expect((view.container.querySelector('[aria-label="PDF request title"]') as HTMLInputElement).value).toBe('Pending title');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shows the operator handoff requirement after a definitive refusal and retains editable copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'An office operator must save this reviewed request. The PDF remains available for review.' }), { status: 403 })));
    view = await mount(React.createElement(DocumentRequestForm, { source: answer }));
    await fill(); await click(view.container.querySelector('input[type=checkbox]'));
    await click(byText(view.container, 'button', 'Save reviewed request'));
    expect(view.text()).toContain('An office operator must save');
    expect(getPendingDocumentDraft()).toBeNull();
    const copy = view.container.querySelector('[aria-label="PDF exact copy English"]') as HTMLTextAreaElement;
    expect(copy.value).toBe('Confirmed price 123.45'); expect(copy.disabled).toBe(false);
  });

});
