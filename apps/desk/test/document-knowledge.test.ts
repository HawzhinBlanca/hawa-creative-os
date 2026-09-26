// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentKnowledgePanel } from '../src/components/DocumentKnowledgePanel.js';
import { KnowledgeSearchPanel } from '../src/components/KnowledgeSearchPanel.js';
import { DocumentInspectionPanel } from '../src/components/DocumentInspectionPanel.js';
import { apiClient, ApiError, type DocumentReceipt, type DocumentKnowledgeState, type KnowledgeSearch } from '../src/api/client.js';
import { mount, click, byText } from './support/desk-harness.js';

const receipt: DocumentReceipt = { clientId: 'client-a', id: 'source-a', sourceSha256: 'a'.repeat(64),
  extractionSha256: 'b'.repeat(64), extractorVersion: 'native-v1', createdAt: '2026-09-26T00:00:00Z', contentUrl: '/source' };
const status: DocumentKnowledgeState = { state: { approved: false, version: 0 }, canManage: true, events: [] };
const results: KnowledgeSearch = { clientId: receipt.clientId, mode: 'postgres_lexical_v1', vectorStatus: 'not_run', rerankerStatus: 'not_run',
  items: [{ text: '<script>untrusted()</script> نرخ ١٢٣', score: 3, truncated: false, citation: {
    documentId: receipt.id, chunkId: 'chunk', pageNumber: 2, chunkSha256: 'c'.repeat(64), sourceSha256: receipt.sourceSha256,
    extractionSha256: receipt.extractionSha256, extractorVersion: receipt.extractorVersion, approvalVersion: 1, approvalActionId: 'action' } }] };
let view: Awaited<ReturnType<typeof mount>> | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => { await view?.unmount(); view = undefined; vi.restoreAllMocks(); localStorage.clear(); });
async function edit(container: HTMLElement, label: string, value: string) {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit(container: HTMLElement) {
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
async function prepare() {
  await click(byText(view!.container, 'button', 'Check reference approval'));
  await edit(view!.container, 'Reference approval reason', 'Reviewed source');
  await click(view!.container.querySelector('[aria-label="Reference original reviewed"]'));
}
describe('approved document Desk controls', () => {
  it('requires current authority, reason and explicit review; changing the reason clears review', async () => {
    vi.spyOn(apiClient.clients, 'documentKnowledge').mockResolvedValue(status);
    const write = vi.spyOn(apiClient.clients, 'changeDocumentKnowledge').mockResolvedValue({ ...status, state: { version: 1, approved: true } });
    const changed = vi.fn();
    view = await mount(React.createElement(DocumentKnowledgePanel, { receipt, onChanged: changed }));
    expect(write).not.toHaveBeenCalled();
    await prepare(); await edit(view.container, 'Reference approval reason', 'Changed review reason');
    expect((byText(view.container, 'button', 'Approve reference search') as HTMLButtonElement).disabled).toBe(true);
    await click(view.container.querySelector('[aria-label="Reference original reviewed"]'));
    await click(byText(view.container, 'button', 'Approve reference search'));
    expect(JSON.parse(write.mock.calls[0][3])).toEqual({ approved: true, expectedVersion: 0, reviewed: true,
      reason: 'Changed review reason', sourceSha256: receipt.sourceSha256, extractionSha256: receipt.extractionSha256 });
    expect(changed).toHaveBeenCalledTimes(1); expect(view.text()).toContain('Approved for reference search');
    expect(localStorage.length).toBe(0);
  });
  it('restores identical action bytes after lost response and renders current revoked state on old replay', async () => {
    vi.spyOn(apiClient.clients, 'documentKnowledge').mockResolvedValue(status);
    const write = vi.spyOn(apiClient.clients, 'changeDocumentKnowledge').mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValue({ ...status, state: { approved: false, version: 2 }, replayed: true });
    view = await mount(React.createElement(DocumentKnowledgePanel, { receipt, onChanged: vi.fn() }));
    await prepare(); await click(byText(view.container, 'button', 'Approve reference search'));
    expect(view.text()).toContain('unconfirmed result');
    await view.unmount(); view = await mount(React.createElement(DocumentKnowledgePanel, { receipt, onChanged: vi.fn() }));
    await click(byText(view.container, 'button', 'Retry saved reference action'));
    expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
    expect(view.text()).toContain('Not available in reference search · version 2'); expect(localStorage.length).toBe(0);
  });
  it('does not send if durable action storage fails, and clears a first definitive refusal for refresh', async () => {
    vi.spyOn(apiClient.clients, 'documentKnowledge').mockResolvedValue(status);
    const write = vi.spyOn(apiClient.clients, 'changeDocumentKnowledge').mockRejectedValue(new ApiError(409, 'Version changed'));
    view = await mount(React.createElement(DocumentKnowledgePanel, { receipt, onChanged: vi.fn() }));
    await prepare();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Storage full'); });
    await click(byText(view.container, 'button', 'Approve reference search'));
    expect(write).not.toHaveBeenCalled(); expect(view.text()).toContain('Storage full');
    storage.mockRestore(); await click(byText(view.container, 'button', 'Approve reference search'));
    expect(view.text()).toContain('Version changed'); expect(localStorage.length).toBe(0);
    expect(byText(view.container, 'button', 'Approve reference search')).toBeUndefined();
  });
  it('shows a read-only state to an unnamed or unauthorized user', async () => {
    vi.spyOn(apiClient.clients, 'documentKnowledge').mockResolvedValue({ ...status, canManage: false });
    view = await mount(React.createElement(DocumentKnowledgePanel, { receipt, onChanged: vi.fn() }));
    await click(byText(view.container, 'button', 'Check reference approval'));
    expect(view.text()).toContain('named client knowledge manager'); expect(view.container.querySelector('input')).toBeNull();
  });
  it('discards results from a previous client even when transport ignores cancellation', async () => {
    let release!: (r: KnowledgeSearch) => void;
    vi.spyOn(apiClient.clients, 'searchKnowledge').mockReturnValue(new Promise(resolve => { release = resolve; }));
    const container = document.createElement('div'), root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(KnowledgeSearchPanel, { clientId: receipt.clientId, revision: 0, onOpen: vi.fn() })); });
      await edit(container, 'Search reference text', 'Price'); await submit(container);
      await act(async () => { root.render(React.createElement(KnowledgeSearchPanel, { clientId: 'client-b', revision: 0, onOpen: vi.fn() })); });
      await act(async () => { release(results); });
      expect(container.textContent).not.toContain('untrusted');
    } finally { await act(async () => root.unmount()); }
  });
  it('renders citations as text and opens the exact saved source page into the reviewed request flow', async () => {
    vi.spyOn(apiClient.clients, 'searchKnowledge').mockResolvedValue(results);
    const open = vi.spyOn(apiClient.clients, 'document').mockResolvedValue({ clientId: receipt.clientId, sourceSaved: true, approved: false, receipt,
      document: { sourceSha256: receipt.sourceSha256, chunks: [{ chunkId: 'chunk', pageNumber: 2, text: results.items[0].text }],
        extraction: { version: receipt.extractorVersion, pageCount: 2, limitations: ['OCR unavailable'] } } });
    view = await mount(React.createElement(DocumentInspectionPanel, { clientId: receipt.clientId }));
    await edit(view.container, 'Search reference text', 'Price'); await submit(view.container);
    expect(view.container.querySelector('script')).toBeNull(); expect(view.text()).toContain(results.items[0].text);
    await click(byText(view.container, 'button', 'Review saved PDF'));
    expect(open).toHaveBeenCalledWith(receipt.clientId, receipt.id, expect.any(AbortSignal));
    expect((view.container.querySelector('[aria-label="PDF page"]') as HTMLSelectElement).value).toBe('2');
    expect((view.container.querySelector('[aria-label="PDF exact copy English"]') as HTMLTextAreaElement).value).toBe('');
  });
});
