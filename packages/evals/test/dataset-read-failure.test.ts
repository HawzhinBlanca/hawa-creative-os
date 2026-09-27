import { afterEach, expect, it, vi } from 'vitest';
import {readFileSync} from 'node:fs';
import {readFixtureDataset,fixtureDatasetCatalog} from '../src/datasets.js';
vi.mock('node:fs',async original=>{const actual=await original<typeof import('node:fs')>();return {...actual,readFileSync:vi.fn(actual.readFileSync)};});
afterEach(()=>vi.mocked(readFileSync).mockReset());
it.each(['{"id":"same"}\n{"id":"same"}', '{"message":"missing ID"}', 'not-json'])('refuses invalid case identity or syntax without inventing a count',content=>{
  vi.mocked(readFileSync).mockReturnValue(Buffer.from(content));
  expect(()=>readFixtureDataset('brief')).toThrow();
  expect(fixtureDatasetCatalog().every(dataset=>dataset.status==='unavailable' && dataset.casesCount===null && dataset.source===null)).toBe(true);
});
it('reports a missing corpus as unavailable and an empty corpus as zero cases',()=>{
  vi.mocked(readFileSync).mockImplementation(()=>{throw new Error('PRIVATE_FILESYSTEM_PATH');});
  expect(JSON.stringify(fixtureDatasetCatalog())).not.toContain('PRIVATE_FILESYSTEM_PATH');
  vi.mocked(readFileSync).mockReturnValue(Buffer.from(''));expect(readFixtureDataset('brief')?.cases).toEqual([]);
});

it('rejects invalid UTF-8 instead of hashing replacement text',()=>{
  vi.mocked(readFileSync).mockReturnValue(Buffer.from([0xff]));
  expect(()=>readFixtureDataset('brief')).toThrow();
});
