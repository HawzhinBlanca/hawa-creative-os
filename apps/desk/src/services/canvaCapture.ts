/**
 * "Capture for Review": a PNG export of the task's linked Canva design, taken through Core.
 *
 * Core submits the export to Canva, then on a status check downloads the file, validates its bytes,
 * hashes it and stores it as evidence (`exportStatus` in canva-connect-service). It runs no QA and
 * creates no design revision, so the result reports only what Core stored. Until 2026-09-19 the
 * button made no server call at all and displayed an invented revision, hash and passing QA report.
 */

export interface CaptureApi {
  taskState(taskId: string): Promise<any>;
  export(taskId: string, format: 'png', expectedVersion: number, key: string): Promise<any>;
  resume(taskId: string, operationId: string): Promise<any>;
}

export interface CaptureOutcome {
  tone: 'success' | 'info' | 'error';
  text: string;
}

export interface CaptureOptions {
  /** Idempotency key for the export request. */
  key: string;
  /** Status checks after submission before handing over to the Canva panel. */
  attempts?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function captureForReview(api: CaptureApi, taskId: string, options: CaptureOptions): Promise<CaptureOutcome> {
  const { key, attempts = 10, waitMs = 2000, sleep = wait } = options;
  const state = await api.taskState(taskId);
  if (!state?.binding) {
    return { tone: 'error', text: 'Nothing captured: this task has no linked Canva design. Create or link one in the Canva panel first.' };
  }
  let result = await api.export(taskId, 'png', state.binding.version, key);
  for (let i = 0; i < attempts && result?.status === 'submitted' && result.operationId; i++) {
    await sleep(waitMs);
    result = await api.resume(taskId, result.operationId);
  }
  return describeCapture(result);
}

export function describeCapture(result: any): CaptureOutcome {
  const status = result?.status;
  const operation = result?.operationId ? ` (operation ${String(result.operationId).slice(0, 8)})` : '';
  if (status === 'retrieved') {
    const artifact = result.artifact;
    if (!artifact?.sha256) {
      return { tone: 'error', text: `Canva reported the export retrieved, but Core returned no stored file${operation}. Check the Canva panel.` };
    }
    const bytes = Number(artifact.byte_size);
    const size = Number.isFinite(bytes) ? `${bytes.toLocaleString()} bytes, ` : '';
    return {
      tone: 'success',
      text: `Captured a PNG of the Canva design and stored it: ${size}SHA-256 ${artifact.sha256.slice(0, 12)}…. QA has not run; copy, logo, layout and human approval are still required.`,
    };
  }
  if (status === 'submitted') {
    return { tone: 'info', text: `Export submitted to Canva and still running${operation}. Use "Check / resume" in the Canva panel to retrieve it.` };
  }
  if (status === 'stale') {
    return { tone: 'error', text: 'Nothing captured: the design changed in Canva during the export. Let it finish saving, then capture again.' };
  }
  if (status === 'failed') {
    return { tone: 'error', text: `Nothing captured: Canva reported the export failed${operation}.` };
  }
  if (status === 'uncertain') {
    return { tone: 'error', text: `Nothing captured: ${result.message || 'the export submission could not be confirmed.'} Resolve it in the Canva panel before capturing again.` };
  }
  return { tone: 'error', text: `Nothing captured: Core returned an unexpected export status (${status ?? 'none'}).` };
}
