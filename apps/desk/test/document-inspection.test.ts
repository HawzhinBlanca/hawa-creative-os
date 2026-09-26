// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { DocumentInspectionPanel } from '../src/components/DocumentInspectionPanel.js';
import { apiClient, type DocumentInspection } from '../src/api/client.js';
import { mount, click, byText } from './support/desk-harness.js';
let view: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => { await view?.unmount(); view = undefined; vi.restoreAllMocks(); });
const answer = (clientId: string): DocumentInspection => ({ clientId, sourceSaved: false, approved: false,
  document: { sourceSha256: 'a'.repeat(64), extraction: { version: 'native', pageCount: 2, limitations: ['OCR is not extracted.'] },
    chunks: [{ chunkId: '1', pageNumber: 1, text: '<script>exact untrusted text</script>' }, { chunkId: '2', pageNumber: 2, text: 'Second page' }] } });
async function selectFile(container: HTMLElement, size = 15) {
  const input = container.querySelector('input')!;
  Object.defineProperty(input, 'files', { value: [new File(['x'.repeat(size)], 'source.pdf', { type: 'application/pdf' })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
describe('PDF inspection UI', () => {
  it('renders untrusted text safely, switches pages and makes unsaved state explicit', async () => {
    vi.spyOn(apiClient.clients, 'inspectDocument').mockResolvedValue(answer('a'));
    view = await mount(React.createElement(DocumentInspectionPanel, { clientId: 'a' }));
    await selectFile(view.container); await click(byText(view.container, 'button', 'Preview PDF text'));
    expect(view.text()).toContain('have not been saved or approved');
    expect(view.text()).toContain('<script>exact untrusted text</script>');
    expect(view.container.querySelector('script')).toBeNull();
    const select = view.container.querySelector('select')!;
    await act(async () => { select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(view.text()).toContain('Second page');
    expect(view.text()).not.toContain('exact untrusted text');
  });
  it('refuses excessive input and shows a parser failure without stale text', async () => {
    const call = vi.spyOn(apiClient.clients, 'inspectDocument').mockRejectedValue(new Error('OCR required'));
    view = await mount(React.createElement(DocumentInspectionPanel, { clientId: 'a' }));
    await selectFile(view.container, 20 * 1024 * 1024 + 1);
    expect(view.text()).toContain('no larger than 20 MiB'); expect(call).not.toHaveBeenCalled();
    await selectFile(view.container); await click(byText(view.container, 'button', 'Preview PDF text'));
    expect(view.container.querySelector('[role=alert]')?.textContent).toBe('OCR required');
    expect(view.text()).not.toContain('have not been saved');
  });
  it('discards an old client response even if the transport ignores cancellation', async () => {
    let release!: (value: DocumentInspection) => void;
    vi.spyOn(apiClient.clients, 'inspectDocument').mockReturnValue(new Promise(resolve => { release = resolve; }));
    const container = document.createElement('div'); document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(DocumentInspectionPanel, { clientId: 'a' })));
      await selectFile(container); await click(byText(container, 'button', 'Preview PDF text'));
      await act(async () => root.render(React.createElement(DocumentInspectionPanel, { clientId: 'b' })));
      await act(async () => { release(answer('a')); });
      expect(container.textContent).not.toContain('exact untrusted text');
      expect(container.textContent).not.toContain('have not been saved');
      expect((byText(container, 'button', 'Preview PDF text') as HTMLButtonElement).disabled).toBe(true);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
