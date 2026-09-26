// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { SourceFilesPanel } from '../src/components/SourceFilesPanel.js';
import { apiClient, type RetainedSourceFile } from '../src/api/client.js';
import { mount, click, byText } from './support/desk-harness.js';

let view: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => { await view?.unmount(); view = undefined; vi.restoreAllMocks(); });
const source = (clientId: string): RetainedSourceFile => ({ clientId, updateId: 12, sourceSha256: 'a'.repeat(64),
  createdAt: '2026-09-27T00:00:00Z', documentId: null, stage: 'extraction_stopped', message: 'OCR is required. <script>untrusted</script>' });

it('offers retained originals after extraction failure, displays copy review truthfully and opens available extraction', async () => {
  const onOpen = vi.fn();
  vi.spyOn(apiClient.clients, 'sourceFiles').mockResolvedValue({ clientId: 'a', items: [source('a'), {
    ...source('a'), updateId: 13, documentId: 'document-a', stage: 'copy_confirmed', message: null,
  }] });
  const download = vi.spyOn(apiClient.clients, 'sourceFileContent').mockRejectedValue(new Error('Original is damaged.'));
  view = await mount(React.createElement(SourceFilesPanel, { clientId: 'a', onOpen }));
  await click(byText(view.container, 'button', 'Browse Telegram PDFs'));
  expect(view.text()).toContain('Extraction stopped; original available');
  expect(view.text()).toContain('Requester copy reviewed'); expect(view.container.querySelector('script')).toBeNull();
  await click(byText(view.container, 'button', 'Download retained PDF'));
  expect(download).toHaveBeenCalledWith('a', 12, expect.any(AbortSignal));
  expect(view.container.querySelector('[role=alert]')?.textContent).toBe('Original is damaged.');
  await click(byText(view.container, 'button', 'Review extracted text'));
  expect(onOpen).toHaveBeenCalledWith('document-a');
});

it('discards late source listings when the selected client changes even if cancellation is ignored', async () => {
  let release!: (value: { clientId: string; items: RetainedSourceFile[] }) => void;
  vi.spyOn(apiClient.clients, 'sourceFiles').mockReturnValue(new Promise(resolve => { release = resolve; }));
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(SourceFilesPanel, { clientId: 'a', onOpen: vi.fn() })));
    await click(byText(container, 'button', 'Browse Telegram PDFs'));
    await act(async () => root.render(React.createElement(SourceFilesPanel, { clientId: 'b', onOpen: vi.fn() })));
    await act(async () => release({ clientId: 'a', items: [source('a')] }));
    expect(container.textContent).not.toContain('OCR is required');
    expect(container.querySelector('li')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('refuses a returned listing that belongs to a different client', async () => {
  vi.spyOn(apiClient.clients, 'sourceFiles').mockResolvedValue({ clientId: 'a', items: [source('b')] });
  view = await mount(React.createElement(SourceFilesPanel, { clientId: 'a', onOpen: vi.fn() }));
  await click(byText(view.container, 'button', 'Browse Telegram PDFs'));
  expect(view.container.querySelector('[role=alert]')?.textContent).toBe('Source client could not be verified.');
  expect(view.container.querySelector('li')).toBeNull();
});
