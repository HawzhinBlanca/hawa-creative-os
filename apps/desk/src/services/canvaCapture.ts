/**
 * "Capture for Review": a preview and checked source of the task's linked Canva design.
 *
 * Core submits the export to Canva, then on a status check downloads the file, validates its bytes,
 * hashes it and stores it as evidence (`exportStatus` in canva-connect-service). Core records the
 * checked source as a revision/QC run; this client reports only that receipt. Until 2026-09-19 the
 * button made no server call at all and displayed an invented revision, hash and passing QA report.
 */

export interface CaptureApi {
  taskState(taskId: string): Promise<any>;
  export(taskId: string, format: 'png' | 'pptx', expectedVersion: number, key: string): Promise<any>;
  resume(taskId: string, operationId: string): Promise<any>;
}

export interface CaptureOutcome {
  tone: 'success' | 'info' | 'error';
  text: string;
  /** A known terminal result may release the browser action identity. */
  completed?: boolean;
}

export interface CaptureOptions {
  /** Idempotency key for the export request. */
  key: string;
  expectedBinding?: { designId: string; version: number };
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
  if (options.expectedBinding && (options.expectedBinding.designId !== state.binding.designId || options.expectedBinding.version !== state.binding.version))
    return {tone:'error',text:'The linked design changed before capture. Start a fresh capture of the current design.',completed:true};
  const capture = async (format: 'png' | 'pptx') => {
    let result = await api.export(taskId, format, state.binding.version, `${key}-${format}`);
    for (let i = 0; i < attempts && result?.status === 'submitted' && result.operationId; i++) {
      await sleep(waitMs);
      result = await api.resume(taskId, result.operationId);
    }
    return result;
  };
  const png = await capture('png');
  if (png?.status !== 'retrieved' || !png.artifact?.sha256) return describeCapture(png);
  if (png.artifact.format !== 'png') return {tone:'error',text:'Core did not return a stored PNG preview. Resume the export before review.'};
  const checked = await capture('pptx');
  if (checked?.status !== 'retrieved' || !checked.artifact?.sha256) {
    const outcome = describeCapture(checked);
    return {...outcome,text:`The PNG is stored; the checked source is not ready. ${outcome.text}`};
  }
  if (checked.artifact.format !== 'pptx') return {tone:'error',text:'Core did not return the checked PPTX source. Resume the export before review.'};
  if (checked.review?.status === 'recorded' && typeof checked.review.revisionId === 'string' && checked.review.checkedArtifactId === checked.artifact.id) {
    return {tone:checked.review.qaPassed === true?'success':'info',completed:true,
      text:checked.review.qaPassed === true
        ? 'Preview and checked source recorded for human review. Copy and font checks passed; inspect the design before approving.'
        : 'Preview and checked source recorded. Copy or font checks need correction; approval remains blocked.'};
  }
  return {tone:'error',...(checked.review?.retryable===false?{completed:true}:{}),
    text:`The files are stored, but review is not ready. ${checked.review?.reason || 'Core returned no revision receipt. Resume the checked export before approving.'}`};
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
    return { tone: 'error', text: 'Nothing captured: the design changed in Canva during the export. Let it finish saving, then capture again.', completed:true };
  }
  if (status === 'failed') {
    return { tone: 'error', text: `Nothing captured: Canva reported the export failed${operation}.`, completed:true };
  }
  if (status === 'uncertain') {
    return { tone: 'error', text: `Nothing captured: ${result.message || 'the export submission could not be confirmed.'} Resolve it in the Canva panel before capturing again.` };
  }
  return { tone: 'error', text: `Nothing captured: Core returned an unexpected export status (${status ?? 'none'}).` };
}
