export interface CaptureCheck {
  copyPass?: boolean;
  fontPass?: boolean;
  rtlPass?: boolean;
  observedFonts?: string[];
  requiredFont?: string;
}

export interface CaptureArtifact {
  id: string;
  format: string;
  capture_version?: string | null;
  confirmation_event_id?: string | null;
  content_check?: CaptureCheck | null;
}

/** taskState orders captures newest first and restricts them to the current binding. */
export function canvaPreviewEvidence(artifacts: CaptureArtifact[] = [], expectedConfirmationId?: string | null) {
  if (expectedConfirmationId !== undefined) artifacts = artifacts.filter(a =>
    expectedConfirmationId !== null && a.confirmation_event_id === expectedConfirmationId);
  const preview = artifacts.find(a => a.format === 'png');
  const check = preview?.capture_version ? artifacts.find(a => a.format === 'pptx' &&
    a.capture_version === preview.capture_version && a.content_check)?.content_check : undefined;
  const passed = check?.copyPass === true && check.fontPass === true && check.rtlPass === true;
  return { preview, check, passed,
    caption: !check ? 'This preview has no matching copy and font check. Check the current Canva version.'
      : passed ? 'Captured text checks passed. Human visual review is still required.'
        : 'Captured text checks need correction. Approval remains blocked.' };
}
