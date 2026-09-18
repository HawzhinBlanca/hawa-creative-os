import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureForReview, describeCapture, type CaptureApi } from '../src/services/canvaCapture.js';

const TASK = '6f1c2a3b-0000-4000-8000-000000000001';
const OP = '9a8b7c6d-0000-4000-8000-000000000002';
const SHA = 'c0ffee'.repeat(10) + 'abcd';
const retrieved = { operationId: OP, status: 'retrieved', artifact: { id: 'a1', format: 'png', sha256: SHA, byte_size: 482113 }, qaStatus: 'not_run' };

function fakeApi(overrides: Partial<Record<keyof CaptureApi, any>> = {}) {
  return {
    taskState: vi.fn(async () => ({ binding: { designId: 'DAG1', version: 3, status: 'bound' }, artifacts: [], operations: [] })),
    export: vi.fn(async () => ({ operationId: OP, status: 'submitted', qaStatus: 'not_run' })),
    resume: vi.fn(async () => retrieved),
    ...overrides,
  };
}
const noSleep = vi.fn(async () => {});

describe('Capture for Review takes a real Canva export through Core', () => {
  it('exports PNG against the current binding version, waits for retrieval, and reports only what Core stored', async () => {
    const api = fakeApi();
    const outcome = await captureForReview(api, TASK, { key: 'capture-key-0001', sleep: noSleep });
    expect(api.export).toHaveBeenCalledWith(TASK, 'png', 3, 'capture-key-0001');
    expect(api.resume).toHaveBeenCalledWith(TASK, OP);
    expect(outcome).toEqual({
      tone: 'success',
      text: `Captured a PNG of the Canva design and stored it: ${(482113).toLocaleString()} bytes, SHA-256 ${SHA.slice(0, 12)}…. QA has not run; copy, logo, layout and human approval are still required.`,
    });
  });

  it('captures nothing and never exports when the task has no linked design', async () => {
    const api = fakeApi({ taskState: vi.fn(async () => ({ binding: null, artifacts: [], operations: [] })) });
    const outcome = await captureForReview(api, TASK, { key: 'capture-key-0002', sleep: noSleep });
    expect(outcome.tone).toBe('error');
    expect(outcome.text).toMatch(/^Nothing captured: this task has no linked Canva design/);
    expect(api.export).not.toHaveBeenCalled();
  });

  it('hands over to the Canva panel when the export is still running after the checks', async () => {
    const api = fakeApi({ resume: vi.fn(async () => ({ operationId: OP, status: 'submitted' })) });
    const outcome = await captureForReview(api, TASK, { key: 'capture-key-0003', attempts: 3, sleep: noSleep });
    expect(api.resume).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({ tone: 'info', text: 'Export submitted to Canva and still running (operation 9a8b7c6d). Use "Check / resume" in the Canva panel to retrieve it.' });
  });

  it('lets a refused request reach the caller instead of turning it into a capture', async () => {
    const refusal = new Error('An export of this format is already pending or uncertain; resume the existing operation');
    const api = fakeApi({ export: vi.fn(async () => { throw refusal; }) });
    await expect(captureForReview(api, TASK, { key: 'capture-key-0004', sleep: noSleep })).rejects.toBe(refusal);
  });

  it('reports every non-retrieved outcome as nothing captured', () => {
    expect(describeCapture({ operationId: OP, status: 'stale' }).text).toMatch(/^Nothing captured: the design changed in Canva/);
    expect(describeCapture({ operationId: OP, status: 'failed' })).toEqual({ tone: 'error', text: 'Nothing captured: Canva reported the export failed (operation 9a8b7c6d).' });
    expect(describeCapture({ operationId: OP, status: 'uncertain', message: 'Export submission could not be confirmed.' }).text)
      .toBe('Nothing captured: Export submission could not be confirmed. Resolve it in the Canva panel before capturing again.');
    expect(describeCapture({ operationId: OP, status: 'retrieved', artifact: null }).tone).toBe('error');
    expect(describeCapture(undefined)).toEqual({ tone: 'error', text: 'Nothing captured: Core returned an unexpected export status (none).' });
  });

  it('WorkScreen builds no revision, hash or QA result of its own', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/WorkScreen.tsx'), 'utf8');
    const handler = source.slice(source.indexOf('const handleCaptureForReview'), source.indexOf('// Primary Action 3'));
    expect(handler).toContain('captureForReview(apiClient.canva');
    expect(handler).not.toMatch(/getRandomValues|qaReport|latestRevision|AWAITING_APPROVAL|setTimeout/);
    expect(source).not.toMatch(/Automated QA preflight passed|sample_kaae_preview/);
  });
});
