// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { OfficeLibraryPhotos } from '../src/components/OfficeLibraryPhotos.js';
import { mount } from './support/desk-harness.js';

afterEach(() => { document.body.innerHTML = ''; });

it('ADR-280: shows which office archive photos a run was given and why, and nothing for a run without the record', async () => {
  const record = { version: 1, provenance: 'office_library', status: 'attached', photos: [
    { id: 'olp_0123456789abcdef', description: 'Evaluators in a classroom', date: '2026-05', reasons: ['same kind of event: field visit', 'sharp (sharpness 0.8)'] },
  ] };
  const view = await mount(React.createElement(OfficeLibraryPhotos, { record }));
  expect(view.text()).toContain('Office photo library');
  expect(view.text()).toContain('one photo from the office archive');
  expect(view.text()).toContain('olp_0123456789abcdef');
  expect(view.text()).toContain('Evaluators in a classroom');
  expect(view.text()).toContain('same kind of event: field visit');
  expect(view.container.querySelector('button')).toBeNull();
  await view.unmount();
  const none = await mount(React.createElement(OfficeLibraryPhotos, { record: undefined }));
  expect(none.text()).toBe('');
  await none.unmount();
  const miss = await mount(React.createElement(OfficeLibraryPhotos, { record: { provenance: 'office_library', status: 'no_match', photos: [], reason: 'No usable library photo matches this request.' } }));
  expect(miss.text()).toContain('No archive photo was used: No usable library photo matches this request.');
  await miss.unmount();
});
